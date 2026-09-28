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

export function parseHookInput(harness: Harness, raw: string): HookInput {
  const json = JSON.parse(raw);
  const hookEventName = HookEventNameSchema.parse(json.hook_event_name);
  const cwd = json.cwd as string;
  const toolName = json.tool_name as string | undefined;
  const filePath: string | undefined = json.tool_input?.file_path;
  return { harness, hookEventName, cwd, toolName, filePath };
}

export function renderHookOutput(hookEventName: HookInput["hookEventName"], additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext },
  });
}
