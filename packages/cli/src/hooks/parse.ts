import { readFileSync } from "node:fs";
import { z } from "zod";
import * as path from "node:path";
import type { Harness } from "@kingpost/protocol";

const HookEventNameSchema = z.enum(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]);

export interface HookInput {
  harness: Harness;
  hookEventName: z.infer<typeof HookEventNameSchema>;
  cwd: string;
  toolName?: string;
  filePath?: string;
  proposedContent?: string;
}

// The pieces of node:path we need, narrowed so tests can inject `path.win32`/`path.posix`
// to deterministically exercise both platforms' semantics regardless of which OS the test
// suite itself runs on. Production code relies on the default (the platform-native `path`
// module), so on a real Windows machine this automatically gets win32 behavior for free.
type PathModule = Pick<typeof path, "isAbsolute" | "relative" | "sep">;

// Exported for tests only (see parse.test.ts's "Windows path" cases) — not part of the
// module's public API surface otherwise.
export function toProjectRelative(
  cwd: string,
  filePath: string | undefined,
  pathMod: PathModule = path
): string | undefined {
  if (!filePath) return undefined;
  if (!pathMod.isAbsolute(filePath)) return filePath; // already relative (e.g. Codex's apply_patch)
  const rel = pathMod.relative(cwd, filePath);
  // If filePath isn't actually under cwd, `relative` produces a path starting with "..".
  // Keep the original absolute path in that case (matches existing "leave it absolute,
  // isContractPath/claimsOverlap simply won't match it" behavior for out-of-project edits).
  if (rel.startsWith("..")) return filePath;
  // Downstream logic (isContractPath, claimsOverlap) works on LOGICAL project-relative
  // paths, not OS file paths — normalize to forward slashes regardless of platform so a
  // Windows agent's `server\auth\login.ts` compares equal to a Mac agent's `server/auth/login.ts`.
  return pathMod.sep === "/" ? rel : rel.split(pathMod.sep).join("/");
}

// Codex's apply_patch tool_input has no structured file_path field — the path is embedded in
// the patch text itself (e.g. "*** Update File: contracts/api.ts"). A generic Bash command has
// no reliable single-file signal (e.g. `sed -i` could touch anything) and is intentionally left
// unextracted.
//
// Known limitation: only extracts the FIRST file from a multi-file apply_patch call
// (Codex's *** Begin Patch envelope can contain several *** Update/Add File: sections).
// A single apply_patch editing 2+ contract files will only publish/detect the first —
// accepted for the MVP; fixing this means HookInput.filePath becoming string[] and
// handlers.ts looping over it, which is real scope beyond this fix.
function extractApplyPatchFilePath(command: string): string | undefined {
  const match = command.match(/\*\*\* (?:Update|Add) File: (.+)/);
  return match ? match[1].trim() : undefined;
}

/** The body of the FIRST `*** Add File:`/`*** Update File:` section in an apply_patch command —
 * every line between that header and the next `*** `-prefixed line (another section header, or
 * `*** End Patch`). Mirrors extractApplyPatchFilePath's own "only the first file" scope limit,
 * so a path this module extracts and the content computed from this section always refer to the
 * same file. Returns null if no Add/Update header is found (e.g. a Delete-only patch). */
function firstApplyPatchSection(command: string): { kind: "add" | "update"; bodyLines: string[] } | null {
  const lines = command.split("\n");
  const startIdx = lines.findIndex((l) => /^\*\*\* (Add|Update) File: /.test(l));
  if (startIdx === -1) return null;
  const kind = lines[startIdx].startsWith("*** Add File:") ? "add" : "update";
  const bodyLines: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("*** ")) break;
    bodyLines.push(lines[i]);
  }
  return { kind, bodyLines };
}

/** Index of the first run of lines in `haystack` (at or after `from`) that equals `needle`
 * line-for-line, or -1. Whole-line equality, never substring: a removed line must not "match"
 * the tail of a longer line. */
function findLines(haystack: string[], needle: string[], from: number): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Applies every hunk of an apply_patch "Update File" body to `current` and returns the result,
 * or undefined if any hunk can't be located verbatim (fail open — never a guessed result).
 *
 * Hunk format (apply_patch's grammar, confirmed against real Codex output): a hunk starts at a
 * line beginning "@@" (any trailing scope header is ignored); every following line carries a
 * ONE-character prefix — " " context (kept), "-" removed, "+" added — which is stripped. Context
 * lines being space-prefixed is easy to miss: a single-line edit usually comes with none, so only
 * a multi-line change shows it. Keeping that space made the "before" text unmatchable and every
 * such edit silently failed open.
 *
 * Hunks are ordered and non-overlapping, so each is searched for from where the previous one
 * ended — otherwise an identical earlier block would capture a later hunk and corrupt the result.
 * Files are matched LF-normalized so a CRLF checkout (Git for Windows' default) still matches. */
function applyPatchHunks(current: string, bodyLines: string[]): string | undefined {
  const hunks: string[][] = [];
  for (const line of bodyLines) {
    if (line.startsWith("@@")) hunks.push([]);
    else if (hunks.length > 0) hunks[hunks.length - 1].push(line);
  }
  if (hunks.length === 0) return undefined;

  let lines = current.replace(/\r\n/g, "\n").split("\n");
  let cursor = 0;
  for (const hunk of hunks) {
    // A trailing "" is a split() artifact; a real blank context line is " " (prefixed).
    while (hunk.length > 0 && hunk[hunk.length - 1] === "") hunk.pop();

    const before: string[] = [];
    const after: string[] = [];
    for (const line of hunk) {
      if (line.startsWith("-")) before.push(line.slice(1));
      else if (line.startsWith("+")) after.push(line.slice(1));
      else {
        const context = line.startsWith(" ") ? line.slice(1) : line;
        before.push(context);
        after.push(context);
      }
    }
    // Nothing to anchor on (a pure insertion with no context): can't tell WHERE it goes.
    if (before.length === 0) return undefined;

    const at = findLines(lines, before, cursor);
    if (at === -1) return undefined;
    lines = [...lines.slice(0, at), ...after, ...lines.slice(at + before.length)];
    cursor = at + after.length;
  }
  return lines.join("\n");
}

/** Computes proposed content for an apply_patch call: a brand-new file (every body line
 * "+"-prefixed — the new content is exactly those lines with "+" stripped) or an update of an
 * existing file (one or more "@@" hunks, see applyPatchHunks). Bails (undefined) on anything it
 * can't reconstruct with confidence — an Add-File body with a non-"+" line, or any hunk that
 * doesn't match the current file line-for-line — rather than risk silently computing the
 * WRONG proposed content from a partial reconstruction. `rawFilePath` is the caller's
 * already-computed `extractApplyPatchFilePath(command)` result, threaded through rather than
 * re-parsed here, so the path used for `filePath` and the path used to read the current file
 * for diffing are guaranteed to be the exact same value. */
function computeApplyPatchContent(command: string, rawFilePath: string | undefined, cwd: string): string | undefined {
  const section = firstApplyPatchSection(command);
  if (!section) return undefined;

  if (section.kind === "add") {
    // A blank body line only ever arises from a trailing newline before the next "*** " marker
    // or "*** End Patch" (a split() artifact) — a genuine blank line WITHIN the added file's
    // content still shows up as "+" (length 1, not ""), so filtering "" here can't drop real
    // content, only the spurious trailing artifact.
    const nonEmpty = section.bodyLines.filter((l) => l !== "");
    if (nonEmpty.some((l) => !l.startsWith("+"))) return undefined;
    return nonEmpty.map((l) => l.slice(1)).join("\n");
  }

  // kind === "update"
  if (!rawFilePath) return undefined;
  try {
    // rawFilePath may be relative (empirically, Codex has sent both absolute and cwd-relative
    // paths in the "*** Update File:" header across different sessions) — readFileSync resolves
    // a relative path against the PROCESS's cwd, not the hook's reported cwd, so it must be
    // joined explicitly rather than passed through as-is.
    const absolutePath = path.isAbsolute(rawFilePath) ? rawFilePath : path.join(cwd, rawFilePath);
    const current = readFileSync(absolutePath, "utf8");
    return applyPatchHunks(current, section.bodyLines);
  } catch {
    return undefined;
  }
}

// Computes the file content a Write, Edit, or apply_patch tool call is ABOUT to produce, before
// it happens — used so PreToolUse can diff proposed-but-not-yet-written content against a
// contract's current version. Write gives the full new content directly. Edit requires reading
// the CURRENT file and substituting old_string -> new_string. apply_patch (Codex's structured
// diff-application tool — verified empirically to be the ONE tool name real Codex sessions use
// for file edits; Claude Code's "Write"/"Edit" names never appear under Codex) is handled for
// the common single-file, single-hunk case via computeApplyPatchContent above. In every case, if
// the current file can't be read, or the expected old text isn't found verbatim, this returns
// undefined rather than throwing or guessing — a caller that can't determine what's being
// proposed should fail open (don't block), not fail closed on a wrong guess.
//
// Known limitation: a Bash/shell tool call that writes a file (a redirect, `sed -i`, a script)
// has no reliable single-file signal (unlike apply_patch's structured envelope) and is
// intentionally left unextracted — verified empirically that Codex resorts to this for simple
// edits unless explicitly steered toward apply_patch (see AGENTS_MD_BLOCK's guidance on this).
// Any tool other than Write/Edit/apply_patch also returns undefined here.
//
// This is the first place this otherwise-pure parsing module touches disk, and the read below
// is synchronous with no timeout — same posture as handlePostToolUse's own readFileSync in
// handlers.ts (that one isn't actually timeout-protected either, despite living inside an async
// handler raced against HANDLER_TIMEOUT_MS: a synchronous call blocks the event loop, so no
// Promise.race can preempt it once it starts). Both call sites accept this because the file
// being read is always the one the agent itself just decided to edit — small, local, and warm
// in the OS cache in the overwhelmingly common case.
function computeProposedContent(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
  cwd: string,
  rawFilePath: string | undefined
): string | undefined {
  if (!toolInput) return undefined;
  if (toolName === "Write" && typeof toolInput.content === "string") {
    return toolInput.content;
  }
  if (
    toolName === "Edit" &&
    typeof toolInput.file_path === "string" &&
    typeof toolInput.old_string === "string" &&
    typeof toolInput.new_string === "string"
  ) {
    try {
      const current = readFileSync(toolInput.file_path, "utf8");
      if (!current.includes(toolInput.old_string)) return undefined;
      return current.replace(toolInput.old_string, toolInput.new_string);
    } catch {
      return undefined;
    }
  }
  if (toolName === "apply_patch" && typeof toolInput.command === "string") {
    return computeApplyPatchContent(toolInput.command, rawFilePath, cwd);
  }
  return undefined;
}

export function parseHookInput(harness: Harness, raw: string): HookInput {
  const json = JSON.parse(raw);
  const hookEventName = HookEventNameSchema.parse(json.hook_event_name);
  const cwd = json.cwd as string;
  const toolName = json.tool_name as string | undefined;
  const rawFilePath: string | undefined =
    toolName === "apply_patch" ? extractApplyPatchFilePath(json.tool_input?.command ?? "") : json.tool_input?.file_path;
  const filePath = toProjectRelative(cwd, rawFilePath);
  const proposedContent = hookEventName === "PreToolUse" ? computeProposedContent(toolName, json.tool_input, cwd, rawFilePath) : undefined;
  return { harness, hookEventName, cwd, toolName, filePath, proposedContent };
}

export function renderHookOutput(hookEventName: HookInput["hookEventName"], additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext },
  });
}
