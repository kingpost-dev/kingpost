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

export function parseHookInput(harness: Harness, raw: string): HookInput {
  const json = JSON.parse(raw);
  const hookEventName = HookEventNameSchema.parse(json.hook_event_name);
  const cwd = json.cwd as string;
  const toolName = json.tool_name as string | undefined;
  const filePath = toProjectRelative(cwd, json.tool_input?.file_path);
  return { harness, hookEventName, cwd, toolName, filePath };
}

export function renderHookOutput(hookEventName: HookInput["hookEventName"], additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext },
  });
}
