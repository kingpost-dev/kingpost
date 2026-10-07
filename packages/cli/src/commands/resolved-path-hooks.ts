// Windows-safe fallback hook config.
//
// The plugin's own hooks/hooks.json files (plugins/claude-code, plugins/codex) invoke a bare
// `kingpost` on PATH. On Windows, both harnesses run hook commands through Git Bash (or
// PowerShell if Git Bash is absent), and that subprocess inherits the harness's own process
// environment rather than a login shell — so PATH entries added via .bashrc/.bash_profile
// (where npm's global bin usually ends up on Windows) are never loaded, and the plugin hooks
// silently no-op (confirmed: `node: command not found` on a real Windows machine).
//
// Both harnesses merge project-level hook config additively with plugin-shipped hooks rather
// than overriding them, and kingpost's own hook handler (see ../hooks.ts) already fails silently
// and safely by design. So we write a *second* hook config here, at `kingpost init`/`kingpost
// join` time, using the exact resolved absolute paths of the Node binary and this CLI's own
// entry script (no PATH lookup involved) — a safety net that runs alongside the plugin's hooks
// without needing to touch or remove them.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface HookEventSpec {
  event: string;
  matcher?: string;
}

// Same 4 events/matchers as plugins/claude-code/hooks/hooks.json.
export const CLAUDE_HOOK_EVENTS: HookEventSpec[] = [
  { event: "SessionStart", matcher: "startup|resume" },
  { event: "UserPromptSubmit" },
  { event: "PreToolUse", matcher: "Write|Edit" },
  // Bash too, but only AFTER: a shell command can't be checked before it runs, yet a contract it rewrote
  // (`sed -i`, `cat >`) should still be noticed and published rather than slip past Kingpost silently.
  { event: "PostToolUse", matcher: "Write|Edit|Bash" },
];

// Same 4 events/matchers as plugins/codex/hooks/hooks.json.
export const CODEX_HOOK_EVENTS: HookEventSpec[] = [
  { event: "SessionStart", matcher: "startup|resume" },
  { event: "UserPromptSubmit" },
  { event: "PreToolUse", matcher: "apply_patch|Edit|Write|Bash" },
  { event: "PostToolUse", matcher: "apply_patch|Edit|Write|Bash" },
];

// The absolute path to this CLI's own entry script, resolved through any npm bin symlink.
// process.argv[1] is the script Node was actually launched with, which works whether kingpost
// was invoked via a POSIX symlink (global npm installs on macOS/Linux) or a Windows shim that
// already points straight at dist/index.js.
export function resolvedEntryPath(): string {
  return realpathSync(process.argv[1]);
}

/** Identifies a hook object as kingpost's own resolved-path entry for `event`, regardless of
 * the absolute paths baked into it — so a later run (e.g. after a Node/CLI upgrade changes
 * those paths) replaces the old entry instead of piling up a duplicate. */
export function isKingpostClaudeHook(hook: unknown, event: string): boolean {
  if (typeof hook !== "object" || hook === null) return false;
  const h = hook as Record<string, unknown>;
  return (
    h.type === "command" &&
    Array.isArray(h.args) &&
    h.args[1] === "hook" &&
    h.args[2] === event &&
    h.args[3] === "--harness" &&
    h.args[4] === "claude"
  );
}

export function isKingpostCodexHook(hook: unknown, event: string): boolean {
  if (typeof hook !== "object" || hook === null) return false;
  const h = hook as Record<string, unknown>;
  if (h.type !== "command" || typeof h.command !== "string") return false;
  return new RegExp(`\\bhook\\s+${event}\\s+--harness\\s+codex\\b`).test(h.command);
}

function buildClaudeHook(entryPath: string, event: string) {
  return {
    type: "command",
    command: process.execPath,
    args: [entryPath, "hook", event, "--harness", "claude"],
  };
}

function quote(p: string): string {
  return `"${p}"`;
}

/** A PowerShell single-quoted string literal: no `$`/backtick/`"` interpolation, with embedded
 * single quotes escaped by doubling. */
function psQuote(p: string): string {
  return `'${p.replace(/'/g, "''")}'`;
}

// Exported for tests only — `platform`/`execPath` are injectable so the Windows-only branch can be
// exercised on any OS (same pattern as toProjectRelative's injected PathModule in parse.ts).
export function buildCodexHook(
  entryPath: string,
  event: string,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath
) {
  const hook: Record<string, unknown> = {
    type: "command",
    command: `${quote(execPath)} ${quote(entryPath)} hook ${event} --harness codex`,
    additionalContextLimit: 5000,
  };
  if (platform === "win32") {
    // On Windows, Codex launches a hook as `pwsh -NoProfile -Command "<command>"`. PowerShell treats
    // a command STRING that starts with a quoted path as an expression, not an invocation, so the
    // `command` above (a quoted node.exe path — always containing a space under "Program Files")
    // never actually runs. Codex's `commandWindows` override takes a PowerShell-correct form: the
    // call operator `&` followed by single-quoted literals. Other platforms keep `command` alone.
    hook.commandWindows = `& ${psQuote(execPath)} ${psQuote(entryPath)} hook ${event} --harness codex`;
  }
  return hook;
}

/** Upserts `hook` into the matcher group for `matcher` within `groups` (an event's array of
 * matcher groups), replacing any pre-existing kingpost entry for the same event (per `isOwn`)
 * rather than duplicating it. Our entry is removed from EVERY group first, so a project set up
 * under an older matcher (e.g. "Write|Edit" before Bash was added) is migrated instead of ending
 * up with the hook in two groups, which would run it twice per edit. Groups left empty by that
 * removal are dropped; non-kingpost hooks and other groups are left untouched. */
function upsertMatcherGroup(
  groups: unknown,
  event: string,
  matcher: string | undefined,
  hook: Record<string, unknown>,
  isOwn: (hook: unknown, event: string) => boolean
): unknown[] {
  const list: unknown[] = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    if (typeof g === "object" && g !== null && Array.isArray((g as Record<string, unknown>).hooks)) {
      const group = g as Record<string, unknown>;
      const original = group.hooks as unknown[];
      const kept = original.filter((h) => !isOwn(h, event));
      if (kept.length === 0 && original.length > 0) continue; // held only our old entry
      list.push(kept.length === original.length ? g : { ...group, hooks: kept });
    } else {
      list.push(g);
    }
  }
  const key = matcher ?? "";
  const group = list.find((g) => typeof g === "object" && g !== null && ((g as Record<string, unknown>).matcher ?? "") === key) as
    | Record<string, unknown>
    | undefined;
  if (group) {
    const existingHooks = Array.isArray(group.hooks) ? group.hooks : [];
    group.hooks = [...existingHooks.filter((h) => !isOwn(h, event)), hook];
  } else {
    const newGroup: Record<string, unknown> = matcher !== undefined ? { matcher, hooks: [hook] } : { hooks: [hook] };
    list.push(newGroup);
  }
  return list;
}

export function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return typeof parsed === "object" && parsed !== null ? parsed : {};
}

export function upsertClaudeHooks(cwd: string, entryPath: string = resolvedEntryPath()): void {
  const dir = join(cwd, ".claude");
  const path = join(dir, "settings.json");
  const settings = readJsonObject(path);
  const hooks = typeof settings.hooks === "object" && settings.hooks !== null ? (settings.hooks as Record<string, unknown>) : {};

  for (const { event, matcher } of CLAUDE_HOOK_EVENTS) {
    hooks[event] = upsertMatcherGroup(hooks[event], event, matcher, buildClaudeHook(entryPath, event), isKingpostClaudeHook);
  }
  settings.hooks = hooks;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

export function upsertCodexHooks(
  cwd: string,
  entryPath: string = resolvedEntryPath(),
  platform: NodeJS.Platform = process.platform
): void {
  const dir = join(cwd, ".codex");
  const path = join(dir, "hooks.json");
  const config = readJsonObject(path);
  const hooks = typeof config.hooks === "object" && config.hooks !== null ? (config.hooks as Record<string, unknown>) : {};

  for (const { event, matcher } of CODEX_HOOK_EVENTS) {
    hooks[event] = upsertMatcherGroup(hooks[event], event, matcher, buildCodexHook(entryPath, event, platform), isKingpostCodexHook);
  }
  config.hooks = hooks;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

/** Writes both harnesses' resolved-path hook safety nets. Never throws — a failure here (bad
 * permissions, malformed existing JSON, etc.) is logged and swallowed so it can't break
 * `init`/`join`, matching how the rest of this CLI treats non-critical setup steps. */
export function writeResolvedPathHooks(cwd: string): void {
  try {
    upsertClaudeHooks(cwd);
  } catch (e) {
    console.error(`kingpost: couldn't write Claude Code's resolved-path hook safety net (${e instanceof Error ? e.message : e}) — hooks may silently no-op on Windows. Safe to ignore and re-run 'kingpost init'/'kingpost join' later.`);
  }
  try {
    upsertCodexHooks(cwd);
  } catch (e) {
    console.error(`kingpost: couldn't write Codex's resolved-path hook safety net (${e instanceof Error ? e.message : e}) — hooks may silently no-op on Windows. Safe to ignore and re-run 'kingpost init'/'kingpost join' later.`);
  }
}
