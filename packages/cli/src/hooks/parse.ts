import { z } from "zod";
import type { Harness } from "@kingpost/protocol";

const HookEventNameSchema = z.enum(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]);

export interface HookInput {
  harness: Harness;
  hookEventName: z.infer<typeof HookEventNameSchema>;
  cwd: string;
  toolName?: string;
  filePath?: string;
}

function toProjectRelative(cwd: string, filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  if (!filePath.startsWith("/")) return filePath; // already relative (e.g. Codex's apply_patch)
  const normalizedCwd = cwd.endsWith("/") ? cwd : cwd + "/";
  return filePath.startsWith(normalizedCwd) ? filePath.slice(normalizedCwd.length) : filePath;
}

// Codex's apply_patch tool_input has no structured file_path field — the path is embedded in
// the patch text itself (e.g. "*** Update File: contracts/api.ts"). A generic Bash command has
// no reliable single-file signal (e.g. `sed -i` could touch anything) and is intentionally left
// unextracted.
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
