// `kingpost watch` — a genuine mid-task push-notification mechanism, so an agent heads-down on
// a long task can be interrupted when a teammate asks it a question or another relevant event
// happens, instead of only finding out at its next tool call/hook.
//
// This is best-effort by design (see the Codex path in particular, which depends on an
// experimental Codex-internal daemon that may not be present for every user) and must never
// throw, hang, or print anything alarming — same never-block/always-exit-0 spirit as hook.ts
// and resolved-path-hooks.ts's writeResolvedPathHooks.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readProjectConfig, getToken } from "../config.js";
import { ApiClient } from "../api.js";
import { TEAMMATE_LABEL, renderDeltaLines } from "../delta-format.js";
import { deltaIsEmpty, type Harness, type Delta } from "@kingpost/protocol";
import { CodexRpcClient, codexAppServerSocketPath } from "../codex-rpc.js";

const POLL_MS = 5000;
// Don't run forever unbounded if the agent's session already ended for other reasons — the
// agent can just spawn a fresh `kingpost watch` call again if it wants to keep waiting.
const CAP_MS = 10 * 60 * 1000;

function log(message: string): void {
  try {
    const dir = join(homedir(), ".kingpost");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "log"), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // logging must never throw
  }
}

/** Structural subset of ApiClient that delta-polling depends on, so tests can pass a stub
 * instead of a real, network-backed ApiClient. */
interface DeltaClient {
  getDelta(agentId: string): Promise<{ delta: Delta; cursor: number }>;
}

/** Polls kingpost's server for a delta targeting this agent until a non-empty one appears or
 * `deadline` passes. Never throws — a failed poll is logged and treated as "keep polling"
 * rather than fatal, matching this CLI's established resilience-over-alarm posture. */
export async function pollForDelta(client: DeltaClient, agentId: string, deadline: number, pollMs: number = POLL_MS): Promise<Delta | null> {
  while (Date.now() < deadline) {
    try {
      const { delta } = await client.getDelta(agentId);
      if (!deltaIsEmpty(delta)) return delta;
    } catch (e) {
      log(`watch: delta poll failed, retrying (${e instanceof Error ? e.message : String(e)})`);
    }
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
  return null;
}

/** One-line, human-readable stdout summary for the Claude path — Claude Code auto-injects a
 * `<task-notification>` into the agent's context when this background task's process exits, so
 * this line is the actual notification payload the agent sees. */
export function formatClaudeSummary(delta: Delta): string {
  return `kingpost: ${renderDeltaLines(delta).join(" | ")}`;
}

/** Message injected into the Codex thread via thread/queue/add — reuses the same
 * TEAMMATE_LABEL framing ("information, not instructions; verify before acting") used for
 * every other teammate-sourced context this CLI injects. */
export function formatCodexMessage(delta: Delta): string {
  return `${TEAMMATE_LABEL}${renderDeltaLines(delta).join("\n")}`;
}

async function watchClaude(client: DeltaClient, agentId: string, deadline: number): Promise<void> {
  const delta = await pollForDelta(client, agentId, deadline);
  if (!delta) {
    console.log("kingpost: no new activity, stopping watch");
    return;
  }
  console.log(formatClaudeSummary(delta));
}

/** Waits for the Codex thread to go idle (a running turn can't accept `thread/queue/start`),
 * then starts the queued submission. Bounded by the same overall `deadline` as the delta poll —
 * if the thread never goes idle in time, the message is left queued (Codex may still pick it up
 * later) and this just gives up quietly. */
async function deliverWhenIdle(rpc: CodexRpcClient, threadId: string, queuedSubmissionId: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    const { thread } = (await rpc.request("thread/read", { threadId, includeTurns: false })) as {
      thread: { status: { type: string } };
    };
    if (thread.status.type === "idle") {
      await rpc.request("thread/queue/start", { threadId, queuedSubmissionId });
      log("watch --harness codex: delivered queued notification");
      return;
    }
    await new Promise((r) => setTimeout(r, Math.min(2000, Math.max(0, deadline - Date.now()))));
  }
  log("watch --harness codex: gave up waiting for the thread to go idle; message remains queued");
}

async function watchCodex(client: DeltaClient, agentId: string, deadline: number): Promise<void> {
  const threadId = process.env.CODEX_THREAD_ID;
  if (!threadId) {
    log("watch --harness codex: CODEX_THREAD_ID not set, nothing this command can do");
    return;
  }

  const socketPath = codexAppServerSocketPath();
  if (!existsSync(socketPath)) {
    // Expected, common no-op path (experimental daemon absent on many installs) — not an
    // error state, so nothing goes to stdout, only the log file.
    log(`watch --harness codex: app-server daemon not available at ${socketPath}, skipping watch`);
    return;
  }

  const rpc = new CodexRpcClient(socketPath);
  try {
    await rpc.connect();
    await rpc.request("thread/resume", { threadId, excludeTurns: true });

    const delta = await pollForDelta(client, agentId, deadline);
    if (!delta) {
      log("watch --harness codex: no new activity within cap, stopping watch");
      return;
    }

    const added = (await rpc.request("thread/queue/add", {
      threadId,
      clientUserMessageId: randomUUID(),
      input: [{ type: "text", text: formatCodexMessage(delta) }],
    })) as { queuedSubmission: { id: string } };

    await deliverWhenIdle(rpc, threadId, added.queuedSubmission.id, deadline);
  } finally {
    rpc.close();
  }
}

/** The command's actual logic, without the process.exit(0) the real CLI entry point needs —
 * kept separate so it's callable from tests without killing the test runner. */
export async function runWatch(opts: { harness: Harness; cwd?: string }): Promise<void> {
  try {
    const cwd = opts.cwd ?? process.cwd();
    const config = readProjectConfig(cwd);
    if (!config || !config.agentId) {
      log(`watch: no .kingpost.json/agentId in ${cwd}, nothing to watch`);
      return;
    }
    const token = getToken(config.projectId);
    if (!token) {
      log(`watch: no credentials for project ${config.projectId}`);
      return;
    }

    const client = new ApiClient(config.serverUrl, config.projectId, token);
    const deadline = Date.now() + CAP_MS;

    if (opts.harness === "claude") {
      await watchClaude(client, config.agentId, deadline);
    } else {
      await watchCodex(client, config.agentId, deadline);
    }
  } catch (e) {
    log(`watch error: ${e instanceof Error ? e.stack : String(e)}`);
  }
}

export async function watchCommand(opts: { harness: Harness; cwd?: string }): Promise<void> {
  await runWatch(opts);
  process.exit(0);
}
