import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Readable } from "node:stream";
import { hookCommand } from "./hook.js";
import {
  handleSessionStart,
  handleUserPromptSubmit,
  handlePreToolUse,
  handlePostToolUse,
} from "../hooks/handlers.js";

vi.mock("../hooks/handlers.js", () => ({
  handleSessionStart: vi.fn(),
  handleUserPromptSubmit: vi.fn(),
  handlePreToolUse: vi.fn(),
  handlePostToolUse: vi.fn(),
}));
// Keep hook errors out of the real ~/.kingpost/log.
vi.mock("../hooks/log.js", () => ({ log: vi.fn() }));

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

function feedStdin(payload: object): void {
  vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from([JSON.stringify(payload)]) as any);
}

function event(hookEventName: string) {
  return { hook_event_name: hookEventName, cwd: "/tmp/proj", tool_name: "Write", tool_input: { file_path: "/tmp/proj/src/x.ts", content: "c" } };
}

beforeEach(() => {
  vi.mocked(handleSessionStart).mockReset();
  vi.mocked(handleUserPromptSubmit).mockReset();
  vi.mocked(handlePreToolUse).mockReset();
  vi.mocked(handlePostToolUse).mockReset();
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hookCommand — PreToolUse dispatch", () => {
  it("claude + block: writes the JSON deny shape to stdout and exits 0", async () => {
    vi.mocked(handlePreToolUse).mockResolvedValue({ kind: "block", reason: "x" });
    feedStdin(event("PreToolUse"));

    await hookCommand("claude");

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdoutSpy.mock.calls[0][0] as string)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "x" },
    });
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("codex + block: writes the reason to stderr and exits 2", async () => {
    vi.mocked(handlePreToolUse).mockResolvedValue({ kind: "block", reason: "x" });
    feedStdin(event("PreToolUse"));

    await hookCommand("codex");

    expect(stderrSpy).toHaveBeenCalledWith("x");
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it.each(["claude", "codex"] as const)("%s + context: writes the additionalContext JSON and exits 0", async (harness) => {
    vi.mocked(handlePreToolUse).mockResolvedValue({ kind: "context", text: "y" });
    feedStdin(event("PreToolUse"));

    await hookCommand(harness);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdoutSpy.mock.calls[0][0] as string)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "y" },
    });
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it.each(["claude", "codex"] as const)("%s + none: writes nothing and exits 0", async (harness) => {
    vi.mocked(handlePreToolUse).mockResolvedValue({ kind: "none" });
    feedStdin(event("PreToolUse"));

    await hookCommand(harness);

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("passes the parsed input (including proposedContent) to handlePreToolUse", async () => {
    vi.mocked(handlePreToolUse).mockResolvedValue({ kind: "none" });
    feedStdin(event("PreToolUse"));

    await hookCommand("claude");

    expect(handlePreToolUse).toHaveBeenCalledWith(
      expect.objectContaining({ harness: "claude", hookEventName: "PreToolUse", filePath: "src/x.ts", proposedContent: "c" })
    );
  });

  it("a handler that outlives HANDLER_TIMEOUT_MS resolves to none (fail open), exiting 0", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(handlePreToolUse).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ kind: "block", reason: "late" }), 10_000))
      );
      feedStdin(event("PreToolUse"));

      const done = hookCommand("codex");
      await vi.advanceTimersByTimeAsync(3000);
      await done;

      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hookCommand — other events are unchanged", () => {
  it.each([
    ["SessionStart", handleSessionStart],
    ["UserPromptSubmit", handleUserPromptSubmit],
    ["PostToolUse", handlePostToolUse],
  ] as const)("%s: a non-empty string becomes additionalContext JSON on stdout, exit 0", async (name, handler) => {
    vi.mocked(handler).mockResolvedValue("ctx");
    feedStdin(event(name));

    await hookCommand("codex");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handlePreToolUse).not.toHaveBeenCalled();
    expect(JSON.parse(stdoutSpy.mock.calls[0][0] as string)).toEqual({
      hookSpecificOutput: { hookEventName: name, additionalContext: "ctx" },
    });
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it.each([
    ["SessionStart", handleSessionStart],
    ["UserPromptSubmit", handleUserPromptSubmit],
    ["PostToolUse", handlePostToolUse],
  ] as const)("%s: an empty string writes nothing, exit 0", async (name, handler) => {
    vi.mocked(handler).mockResolvedValue("");
    feedStdin(event(name));

    await hookCommand("claude");

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
