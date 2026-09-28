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

export function parseHookInput(harness: Harness, raw: string): HookInput {
  const json = JSON.parse(raw);
  const hookEventName = HookEventNameSchema.parse(json.hook_event_name);
  const cwd = json.cwd as string;
  const toolName = json.tool_name as string | undefined;
  const rawFilePath: string | undefined =
    toolName === "apply_patch" ? extractApplyPatchFilePath(json.tool_input?.command ?? "") : json.tool_input?.file_path;
  const filePath = toProjectRelative(cwd, rawFilePath);
  return { harness, hookEventName, cwd, toolName, filePath };
}

export function renderHookOutput(hookEventName: HookInput["hookEventName"], additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext },
  });
}
