import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseHookInput, renderHookOutput } from "../hooks/parse.js";
import {
  handleSessionStart,
  handleUserPromptSubmit,
  handlePreToolUse,
  handlePostToolUse,
} from "../hooks/handlers.js";
import type { Harness } from "@kingpost/protocol";
import type { HookInput } from "../hooks/parse.js";

const HANDLERS: Record<HookInput["hookEventName"], (input: HookInput) => Promise<string>> = {
  SessionStart: handleSessionStart,
  UserPromptSubmit: handleUserPromptSubmit,
  PreToolUse: handlePreToolUse,
  PostToolUse: handlePostToolUse,
};

const STDIN_TIMEOUT_MS = 1500;
// A cold first call does register-agent + several list calls + a delta fetch over the network,
// and on Windows a fresh node.exe process start adds real overhead on top — measured 1952ms on a
// real machine, above the old shared 1500ms budget, which silently dropped the SessionStart
// brief. Warm/cached calls finish far under this; Promise.race means the higher ceiling only
// matters for the slow, rare case.
const HANDLER_TIMEOUT_MS = 3000;

function log(message: string): void {
  try {
    const dir = join(homedir(), ".kingpost");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "log"), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // logging must never throw
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

export async function hookCommand(harness: Harness): Promise<void> {
  try {
    const raw = await Promise.race([
      readStdin(),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), STDIN_TIMEOUT_MS)),
    ]);
    if (!raw) return;

    const input = parseHookInput(harness, raw);
    const handler = HANDLERS[input.hookEventName];
    if (!handler) return;

    const additionalContext = await Promise.race([
      handler(input),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), HANDLER_TIMEOUT_MS)),
    ]);

    if (additionalContext) {
      process.stdout.write(renderHookOutput(input.hookEventName, additionalContext));
    }
  } catch (err) {
    log(`hook error: ${err instanceof Error ? err.stack : String(err)}`);
  }
  process.exit(0);
}
