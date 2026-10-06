import { parseHookInput, renderHookOutput } from "../hooks/parse.js";
import {
  handleSessionStart,
  handleUserPromptSubmit,
  handlePreToolUse,
  handlePostToolUse,
  type PreToolUseResult,
} from "../hooks/handlers.js";
import { log } from "../hooks/log.js";
import type { Harness } from "@kingpost/protocol";
import type { HookInput } from "../hooks/parse.js";

// PreToolUse has its own dispatch (it can block), so it isn't in this table.
const HANDLERS: Record<Exclude<HookInput["hookEventName"], "PreToolUse">, (input: HookInput) => Promise<string>> = {
  SessionStart: handleSessionStart,
  UserPromptSubmit: handleUserPromptSubmit,
  PostToolUse: handlePostToolUse,
};

const STDIN_TIMEOUT_MS = 1500;
// A cold first call does register-agent + several list calls + a delta fetch over the network,
// and on Windows a fresh node.exe process start adds real overhead on top — measured 1952ms on a
// real machine, above the old shared 1500ms budget, which silently dropped the SessionStart
// brief. Warm/cached calls finish far under this; Promise.race means the higher ceiling only
// matters for the slow, rare case.
const HANDLER_TIMEOUT_MS = 3000;
// PreToolUse can block, and only does network work for contract-file edits (rare), so it gets a longer
// ceiling than the hooks that run on every prompt. Must exceed handlers.ts's BLOCK_CHECK_TIMEOUT_MS.
const PRE_TOOL_USE_TIMEOUT_MS = 9000;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

/** Emits a PreToolUse result and returns the exit code to use. A block is always the
 * `permissionDecision: "deny"` JSON on stdout with exit 0 — for BOTH Claude Code and Codex.
 *
 * Codex also accepts exit 2 + stderr as a deny, but that can't be used here: on Windows, Codex
 * launches every hook command as `pwsh -NoProfile -Command "<command>"`, and `-Command` reports
 * exit 1 for any failed native command regardless of its real exit code, so Codex sees 1 instead
 * of 2 and the "block" silently fails open (upstream issue openai/codex#48183). The JSON deny
 * exits 0, so it passes through that wrapper untouched. Verified against a real Codex CLI
 * (v0.160.0) that the JSON deny blocks `apply_patch` too, not just shell commands. */
function emitPreToolUse(result: PreToolUseResult): number {
  if (result.kind === "block") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: result.reason },
      })
    );
    return 0;
  }
  if (result.kind === "context") {
    process.stdout.write(renderHookOutput("PreToolUse", result.text));
  }
  return 0;
}

export async function hookCommand(harness: Harness): Promise<void> {
  let exitCode = 0;
  try {
    const raw = await Promise.race([
      readStdin(),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), STDIN_TIMEOUT_MS)),
    ]);
    if (!raw) return;

    const input = parseHookInput(harness, raw);

    if (input.hookEventName === "PreToolUse") {
      const result = await Promise.race([
        handlePreToolUse(input),
        new Promise<PreToolUseResult>((resolve) => setTimeout(() => resolve({ kind: "none" }), PRE_TOOL_USE_TIMEOUT_MS)),
      ]);
      exitCode = emitPreToolUse(result);
    } else {
      const handler = HANDLERS[input.hookEventName];
      if (!handler) return;

      const additionalContext = await Promise.race([
        handler(input),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), HANDLER_TIMEOUT_MS)),
      ]);

      if (additionalContext) {
        process.stdout.write(renderHookOutput(input.hookEventName, additionalContext));
      }
    }
  } catch (err) {
    log(`hook error: ${err instanceof Error ? err.stack : String(err)}`);
  }
  process.exit(exitCode);
}
