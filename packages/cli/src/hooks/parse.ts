import type { Harness } from "@kingpost/protocol";

export interface HookInput {
  harness: Harness;
  hookEventName: "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse";
  cwd: string;
  toolName?: string;
  filePath?: string;
}

export function parseHookInput(harness: Harness, raw: string): HookInput {
  const json = JSON.parse(raw);
  const hookEventName = json.hook_event_name as HookInput["hookEventName"];
  const cwd = json.cwd as string;
  const toolName = json.tool_name as string | undefined;
  const filePath: string | undefined =
    json.tool_input?.file_path ?? json.tool_input?.path ?? undefined;
  return { harness, hookEventName, cwd, toolName, filePath };
}

export function renderHookOutput(hookEventName: HookInput["hookEventName"], additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext },
  });
}
