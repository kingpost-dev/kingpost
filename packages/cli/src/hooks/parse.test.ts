import { describe, it, expect } from "vitest";
import { parseHookInput, renderHookOutput } from "./parse.js";

const CLAUDE_SESSION_START = JSON.stringify({
  session_id: "sess_1",
  cwd: "/repo",
  hook_event_name: "SessionStart",
  permission_mode: "default",
});

const CODEX_PRE_TOOL_USE = JSON.stringify({
  session_id: "sess_2",
  cwd: "/repo",
  hook_event_name: "PreToolUse",
  permission_mode: "default",
  tool_name: "apply_patch",
  tool_input: { file_path: "contracts/api.ts" },
});

const CLAUDE_POST_TOOL_USE = JSON.stringify({
  session_id: "sess_3",
  cwd: "/repo",
  hook_event_name: "PostToolUse",
  permission_mode: "default",
  tool_name: "Write",
  tool_input: { file_path: "contracts/api.ts" },
});

describe("parseHookInput", () => {
  it("parses a Claude Code SessionStart payload", () => {
    const parsed = parseHookInput("claude", CLAUDE_SESSION_START);
    expect(parsed).toEqual({
      harness: "claude",
      hookEventName: "SessionStart",
      cwd: "/repo",
      toolName: undefined,
      filePath: undefined,
    });
  });

  it("parses a Codex PreToolUse payload including the file path", () => {
    const parsed = parseHookInput("codex", CODEX_PRE_TOOL_USE);
    expect(parsed).toEqual({
      harness: "codex",
      hookEventName: "PreToolUse",
      cwd: "/repo",
      toolName: "apply_patch",
      filePath: "contracts/api.ts",
    });
  });

  it("parses a Claude Code PostToolUse payload including the file path", () => {
    const parsed = parseHookInput("claude", CLAUDE_POST_TOOL_USE);
    expect(parsed).toEqual({
      harness: "claude",
      hookEventName: "PostToolUse",
      cwd: "/repo",
      toolName: "Write",
      filePath: "contracts/api.ts",
    });
  });

  it("throws on an unrecognized hook_event_name", () => {
    expect(() => parseHookInput("claude", JSON.stringify({ cwd: "/repo", hook_event_name: "SomeFutureEvent" }))).toThrow();
  });
});

describe("renderHookOutput", () => {
  it("wraps additionalContext in hookSpecificOutput for either harness", () => {
    const out = JSON.parse(renderHookOutput("SessionStart", "hello"));
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toBe("hello");
  });
});
