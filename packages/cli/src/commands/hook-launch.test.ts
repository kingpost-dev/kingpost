// End-to-end check of the thing the unit tests can't see: the hook command that `kingpost init`
// ACTUALLY WRITES into .codex/hooks.json, launched the way Codex launches it, against a real
// (mock) Kingpost server, fed a payload captured verbatim from a real Codex session.
//
// Two Windows-only failures were invisible to every mocked test and only surfaced by running real
// Codex on a real Windows machine: (1) Codex runs hooks as `pwsh -NoProfile -Command "<command>"`,
// where `-Command` rewrites our old exit-2 "block" to exit 1 so it failed open (openai/codex#48183);
// (2) a command string beginning with a quoted path is never invoked by PowerShell. This test
// reproduces that exact launch path, so on windows-latest it fails if either comes back.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { upsertCodexHooks } from "./resolved-path-hooks.js";

const DIST = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const HAVE_DIST = existsSync(DIST);
// Locally, `npm test` without a build just skips this; in CI a missing build must FAIL, or a broken
// build step would silently turn this whole guard off.
if (!HAVE_DIST && process.env.CI) throw new Error(`hook-launch.test.ts needs a built CLI at ${DIST} — build before testing`);

const PROJECT_ID = "proj_launch_test";
const TOKEN = "tok_launch_test";
const CONTRACT =
  '{\n  "type": "object",\n  "properties": {\n    "name": { "type": "string" },\n' +
  '    "age": { "type": "number" },\n    "email": { "type": "string" }\n  },\n  "required": ["name", "age"]\n}\n';

// Captured verbatim from a real Codex session (codex-cli 0.160.0): a multi-line edit with
// space-prefixed context lines and a relative path. Removing `age` from properties and `required`.
const BREAKING_PATCH =
  '*** Begin Patch\n*** Update File: contracts/user.json\n@@\n' +
  '-    "age": { "type": "number" },\n     "email": { "type": "string" }\n   },\n' +
  '-  "required": ["name", "age"]\n+  "required": ["name"]\n }\n*** End Patch';
// Adding an optional property is backward compatible.
const NON_BREAKING_PATCH =
  '*** Begin Patch\n*** Update File: contracts/user.json\n@@\n' +
  '-    "email": { "type": "string" }\n+    "email": { "type": "string" },\n+    "nick": { "type": "string" }\n*** End Patch';

let server: Server;
let projectDir: string;
let homeDir: string;
let hookCommand: string;

function preToolUse(command: string, toolName = "apply_patch"): string {
  return JSON.stringify({
    session_id: "s",
    cwd: projectDir,
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: { command },
  });
}

/** Launches the generated hook command exactly as the harness does: via PowerShell's -Command on
 * Windows (where Codex wraps every hook), via `sh -c` elsewhere. Async on purpose: the mock server
 * lives in THIS process, so a blocking spawnSync would freeze it and the hook's HTTP calls would
 * just time out (and fail open, which looks exactly like "no block"). */
function launch(payload: string, extraEnv: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  delete env.KINGPOST_FORCE;
  Object.assign(env, extraEnv);

  let file: string;
  let args: string[];
  if (process.platform === "win32") {
    file = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).error ? "powershell" : "pwsh";
    args = ["-NoProfile", "-Command", hookCommand];
  } else {
    file = "sh";
    args = ["-c", hookCommand];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, cwd: projectDir });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("hook did not exit within 60s"));
    }, 60_000);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(payload);
  });
}

describe.skipIf(!HAVE_DIST)("generated Codex hook, launched like the harness launches it", () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = (req.url ?? "").replace(`/api/projects/${PROJECT_ID}`, "");
      const send = (body: unknown) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(body));
      };
      if (url === "/contracts") return send({ contracts: [{ id: "c1", path: "contracts/user.json", format: "json-schema", currentVersion: 1 }] });
      if (url === "/contracts/c1") return send({ contract: { id: "c1" }, versions: [{ version: 1, content: CONTRACT }] });
      if (url === "/contracts/c1/consumers") return send({ consumers: [{ id: "k1", contractId: "c1", path: "src/uses-user.ts", agentId: null, declared: false }] });
      if (url === "/agents") return send({ agents: [] });
      res.statusCode = 404;
      send({ error: "not found" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    projectDir = mkdtempSync(join(tmpdir(), "kp-launch-proj-"));
    homeDir = mkdtempSync(join(tmpdir(), "kp-launch-home-"));
    mkdirSync(join(projectDir, "contracts"), { recursive: true });
    writeFileSync(join(projectDir, "contracts/user.json"), CONTRACT);
    writeFileSync(
      join(projectDir, ".kingpost.json"),
      JSON.stringify({ serverUrl: `http://127.0.0.1:${port}`, projectId: PROJECT_ID, agentId: "agent_launch_test" })
    );
    mkdirSync(join(homeDir, ".config", "kingpost"), { recursive: true });
    writeFileSync(join(homeDir, ".config", "kingpost", "credentials.json"), JSON.stringify({ [PROJECT_ID]: { token: TOKEN } }));

    // Generate the config with Kingpost's own code and read back what it wrote — so this tests what a
    // real `init` produces, not a hand-copied string.
    upsertCodexHooks(projectDir, DIST);
    const config = JSON.parse(readFileSync(join(projectDir, ".codex", "hooks.json"), "utf8"));
    const hook = config.hooks.PreToolUse[0].hooks[0];
    hookCommand = process.platform === "win32" ? hook.commandWindows : hook.command;
    expect(hookCommand, "the generated hooks.json has no command for this platform").toBeTruthy();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("blocks a breaking multi-line apply_patch with a JSON deny on stdout and exit 0", async () => {
    const { status, stdout, stderr } = await launch(preToolUse(BREAKING_PATCH));
    // Exit 0 matters: through `pwsh -Command`, any nonzero exit is collapsed to 1 and Codex treats the
    // hook as merely failed — i.e. the block would silently not happen.
    expect(status, `stderr was: ${stderr}`).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("Breaking change to `contracts/user.json`");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("src/uses-user.ts");
    expect(stderr).toBe("");
  }, 60_000);

  it("lets a non-breaking apply_patch through silently", async () => {
    const { status, stdout } = await launch(preToolUse(NON_BREAKING_PATCH));
    expect(status).toBe(0);
    expect(stdout).toBe("");
  }, 60_000);

  it("does not block an unrelated shell command (and proves the command string actually runs)", async () => {
    const { status, stdout } = await launch(preToolUse("cat contracts/user.json", "Bash"));
    expect(status).toBe(0);
    expect(stdout).toBe("");
  }, 60_000);

  it("KINGPOST_FORCE=1 turns the block into an advisory instead of a deny", async () => {
    const { status, stdout } = await launch(preToolUse(BREAKING_PATCH), { KINGPOST_FORCE: "1" });
    expect(status).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain("KINGPOST_FORCE=1");
  }, 60_000);
});
