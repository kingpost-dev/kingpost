// End-to-end check against a REAL agent harness (Claude Code or Codex) and the real Kingpost server:
// a breaking edit to a consumed contract must be blocked, and the same request with KINGPOST_FORCE=1
// must go through. The second run is the control: it proves the model WOULD make the edit, so the
// first run staying unchanged is the hook's doing and not the model declining on its own.
//
//   node scripts/e2e-real-harness.mjs <claude|codex>
//
// Two modes (KINGPOST_E2E_MODEL):
//   fake (default) the harness talks to a local scripted model (scripts/fake-model): free, deterministic,
//                  needs no API key. Everything Kingpost does (hooks, blocking, MCP) still runs for real
//                  inside the real harness; only the model's choices are scripted.
//   real           the harness uses its real model and API key (ANTHROPIC_API_KEY / OPENAI_API_KEY). This
//                  is the only mode that can notice a real model choosing a shell write over the edit tool.
//
// Needs the built CLI (npm run build) and the harness binary on PATH. Creates a throwaway project on the
// server (KINGPOST_E2E_SERVER, default https://app.kingpost.dev) and deletes it again when it finishes.
import { spawn, spawnSync } from "node:child_process";
import { startFakeModel } from "./fake-model/server.mjs";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const harness = process.argv[2];
if (harness !== "claude" && harness !== "codex") {
  console.error("usage: node scripts/e2e-real-harness.mjs <claude|codex>");
  process.exit(2);
}

const fakeMode = process.env.KINGPOST_E2E_MODEL !== "real";
const root = resolve(import.meta.dirname, "..");
const cliEntry = join(root, "packages/cli/dist/index.js");

const server = process.env.KINGPOST_E2E_SERVER ?? "https://app.kingpost.dev";
const CONTRACT = "contracts/user.json";
const ORIGINAL =
  JSON.stringify({ type: "object", properties: { name: { type: "string" }, age: { type: "number" }, email: { type: "string" } }, required: ["name"] }, null, 2) + "\n";
const PROMPT =
  `First read ${CONTRACT}, then edit it to remove the age property from properties. Use your file-editing tool, not the shell. ` +
  `Make exactly that one change. Do not call any kingpost_* tools; they are not needed for this task. ` +
  `If the edit is refused, do not try another way around it; just say it was refused.`;

// On Windows the harness CLIs are .cmd shims, which only run through a shell, and a shell does no
// argument quoting. The prompt deliberately has no double quotes or shell metacharacters, so wrapping
// whitespace-containing arguments in double quotes is enough.
const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);
const run = (cmd, args, { cwd, env = {}, timeout = 240_000 } = {}) =>
  process.platform === "win32"
    ? spawnSync([cmd, ...args.map(quote)].join(" "), { cwd, encoding: "utf8", timeout, shell: true, env: { ...process.env, ...env } })
    : spawnSync(cmd, args, { cwd, encoding: "utf8", timeout, env: { ...process.env, ...env } });

// Async variant for harness runs: in fake mode the scripted model server lives in THIS process, and a
// synchronous spawn would block the event loop so the server could never answer (the harness would hang).
const runAsync = (cmd, args, { cwd, env = {}, timeout = 240_000 } = {}) =>
  new Promise((resolveRun) => {
    const full = { ...process.env, ...env };
    const child =
      process.platform === "win32"
        ? spawn([cmd, ...args.map(quote)].join(" "), { cwd, shell: true, env: full, stdio: ["ignore", "pipe", "pipe"] })
        : spawn(cmd, args, { cwd, env: full, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolveRun({ status, stdout, stderr });
    });
  });

// Failures throw so the cleanup in the `finally` below always runs (an exit here would skip it and leak
// the throwaway project); the catch at the bottom reports and sets the exit code.
class Failure extends Error {
  constructor(msg, detail) {
    super(msg);
    this.detail = detail;
  }
}
function fail(msg, detail) {
  throw new Failure(msg, detail);
}

function reportFailure(e) {
  if (!(e instanceof Failure)) {
    console.error(`FAIL [${harness}]: unexpected error: ${e instanceof Error ? e.stack : e}`);
    return;
  }
  console.error(`FAIL [${harness}]: ${e.message}`);
  if (e.detail) console.error(String(e.detail).slice(-8000));
  // The hook swallows its own errors into this log (it must never break the agent), so a silent
  // fail-open shows up here and nowhere else.
  const log = join(homedir(), ".kingpost", "log");
  if (existsSync(log)) console.error(`--- ${log} (tail) ---\n${readFileSync(log, "utf8").slice(-3000)}`);
}

// Which tools did the agent actually use? A contract changed by a shell write is invisible to Kingpost,
// so "the edit wasn't blocked" means something different when the model went around the edit tool.
function toolsUsed(output) {
  const names = [...output.matchAll(/"type":"tool_use","id":"[^"]*","name":"([A-Za-z_]+)"/g)].map((m) => m[1]);
  if (harness === "codex") {
    if (/apply patch|apply_patch/i.test(output)) names.push("apply_patch");
    if (/\bexec\b|succeeded in \d+ms/.test(output)) names.push("shell");
  }
  return [...new Set(names)].join(", ") || "(none detected)";
}

// The CLI ships as one bundle, so talk to the REST API directly. Retries ride out a cold server.
async function api(config, token, method, path, body) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`${config.serverUrl}/api/projects/${config.projectId}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw last;
}

// Codex only loads a project's .codex/hooks.json once the project is trusted (interactively that's
// the /hooks prompt). Give each run its own CODEX_HOME with this directory pre-trusted, so the run is
// isolated from (and never edits) the caller's real Codex config.
function prepareCodexHome(projectDir, fakeUrl) {
  const home = mkdtempSync(join(tmpdir(), "kp-e2e-codex-home-"));
  const trust = `[projects.${JSON.stringify(realpathSync(projectDir))}]\ntrust_level = "trusted"\n`;
  if (fakeUrl) {
    // Codex learns a model's tool set (e.g. freeform apply_patch) from a model catalog, so the fake model
    // ships its own catalog entry, and a custom provider points the Responses API at the fake server.
    copyFileSync(join(root, "scripts/fake-model/codex-catalog.json"), join(home, "catalog.json"));
    writeFileSync(
      join(home, "config.toml"),
      `model_provider = "fake"\nmodel = "kp-fake"\nmodel_catalog_json = ${JSON.stringify(join(home, "catalog.json"))}\n` +
        `[model_providers.fake]\nname = "fake"\nbase_url = "${fakeUrl}/v1"\nwire_api = "responses"\nenv_key = "FAKE_KEY"\n${trust}`
    );
    return home;
  }
  if (process.env.OPENAI_API_KEY) {
    const login = spawnSync("codex", ["login", "--with-api-key"], {
      input: process.env.OPENAI_API_KEY, encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, CODEX_HOME: home },
    });
    if (login.status !== 0) fail("codex login --with-api-key failed", login.stdout + login.stderr);
  } else {
    const realAuth = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
    if (!existsSync(realAuth)) fail("no OPENAI_API_KEY and no existing Codex login to copy");
    copyFileSync(realAuth, join(home, "auth.json"));
  }
  writeFileSync(join(home, "config.toml"), trust);
  return home;
}

// Claude reports its own USD cost; Codex only reports tokens.
function costSummary(output) {
  const usd = [...output.matchAll(/"total_cost_usd":([0-9.]+)/g)].map((m) => Number(m[1]));
  const tokens = [...output.matchAll(/tokens used\s*\n?\s*([0-9,]+)/g)].map((m) => m[1]);
  return usd.length ? `COST [${harness}] $${usd.at(-1).toFixed(4)}` : tokens.length ? `COST [${harness}] ${tokens.at(-1)} tokens` : `COST [${harness}] unknown`;
}

let codexHome;
let fake;
let project; // { config, token } once init has created the throwaway project

// Best-effort cleanup: never mask the test result. A server that predates DELETE /api/projects/:id answers
// 404/405, in which case the project is simply left behind, as it was before the endpoint existed.
async function deleteProject() {
  if (!project) return;
  try {
    const res = await fetch(`${project.config.serverUrl}/api/projects/${project.config.projectId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${project.token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) console.warn(`[${harness}] couldn't delete the throwaway project ${project.config.projectId} (HTTP ${res.status})`);
  } catch (e) {
    console.warn(`[${harness}] couldn't delete the throwaway project: ${e instanceof Error ? e.message : e}`);
  }
}
function harnessCommand(force) {
  const env = force ? { KINGPOST_FORCE: "1" } : {};
  if (harness === "codex") { env.CODEX_HOME = codexHome; if (process.env.KINGPOST_E2E_DEBUG) env.RUST_LOG = "debug"; }
  if (fake && harness === "claude") Object.assign(env, { ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: "fake-key", ANTHROPIC_AUTH_TOKEN: "" });
  if (fake && harness === "codex") env.FAKE_KEY = "fake-key";
  if (harness === "claude") {
    return [
      "claude",
      ["-p", PROMPT, "--model", "claude-haiku-4-5-20251001", "--max-turns", "10", "--permission-mode", "acceptEdits", "--output-format", "stream-json", "--verbose", "--disallowedTools", "Bash"],
      { env },
    ];
  }
  return ["codex", [
    "exec", "--skip-git-repo-check", "--dangerously-bypass-hook-trust",
    // CI runners are throwaway machines, and Codex's own sandbox can't start on them (its shell reads get
    // refused), so there it runs unsandboxed. Locally keep the sandbox.
    "--sandbox", process.env.CI ? "danger-full-access" : "workspace-write",
    PROMPT,
  ], { env }];
}

// Resolve to the real path: on Windows runners tmpdir() is an 8.3 short path (C:\Users\RUNNER~1\...)
// that Claude Code doesn't treat as inside the project, so it refuses to even read the contract.
const dir = realpathSync.native(mkdtempSync(join(tmpdir(), `kp-e2e-${harness}-`)));
console.log(`[${harness}] project dir: ${dir}`);
try {
  mkdirSync(join(dir, "contracts"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, CONTRACT), ORIGINAL);
  writeFileSync(join(dir, "src/uses-user.ts"), `import type { User } from "../contracts/user.json";\nexport const u: User | null = null;\n`);

  if (fakeMode) {
    const ageBlock = `    "age": {\n      "type": "number"\n    },\n`;
    fake = await startFakeModel({
      // Read the contract, then remove the age property: the same edit the real-model prompt asks for.
      claudeSteps: [
        { tool: "Read", input: { file_path: join(dir, CONTRACT) } },
        { tool: "Edit", input: { file_path: join(dir, CONTRACT), old_string: ageBlock, new_string: "" } },
        { text: "Done." },
      ],
      codexSteps: [
        { tool: "exec_command", input: { cmd: `cat ${CONTRACT}` } },
        {
          tool: "apply_patch",
          input: `*** Begin Patch\n*** Update File: ${CONTRACT}\n@@\n     "name": {\n       "type": "string"\n     },\n-    "age": {\n-      "type": "number"\n-    },\n     "email": {\n*** End Patch\n`,
        },
        { text: "Done." },
      ],
    });
  }
  if (harness === "codex") codexHome = prepareCodexHome(dir, fake?.url);
  const init = run("node", [cliEntry, "init", "--name", `e2e-${harness}-${Date.now()}`, "--server-url", server], { cwd: dir });
  if (init.status !== 0) fail("kingpost init failed", init.stdout + init.stderr);

  const config = JSON.parse(readFileSync(join(dir, ".kingpost.json"), "utf8"));
  const token = JSON.parse(readFileSync(join(homedir(), ".config", "kingpost", "credentials.json"), "utf8"))[config.projectId]?.token;
  if (!config.projectId || !token) fail("init didn't produce a project config and credential");
  project = { config, token };
  const { contract } = await api(config, token, "PUT", "/contracts", { path: CONTRACT, content: ORIGINAL, updatedBy: "e2e", format: "json-schema" });
  await api(config, token, "POST", `/contracts/${contract.id}/consumers`, { path: "src/uses-user.ts", agentId: null, declared: true });

  // 1. Without the override the hook must block, leaving the file untouched.
  const [cmd, args, opts] = harnessCommand(false);
  if (fake) fake.requests.length = 0;
  const blocked = await runAsync(cmd, args, { cwd: dir, ...opts });
  const afterBlock = readFileSync(join(dir, CONTRACT), "utf8");
  // In fake mode the strongest evidence is what the harness sent BACK to the model: the tool result must
  // carry the hook's deny text. Appending it lets the checks below see it like any other output.
  const blockOutput = (blocked.stdout ?? "") + (blocked.stderr ?? "") + (fake ? `\n[requests sent to the fake model]\n${JSON.stringify(fake.requests.map((r) => r.body))}` : "");
  if (process.env.KINGPOST_E2E_DEBUG) writeFileSync("/tmp/e2e-block-output.txt", blockOutput);
  console.log(`[${harness}] block run exit=${blocked.status}, tools used: ${toolsUsed(blockOutput)}\n${blockOutput.slice(-1500)}`);
  if (!fakeMode) console.log(costSummary(blockOutput));
  if (afterBlock !== ORIGINAL) fail(`the breaking edit was NOT blocked: the contract changed on disk (tools used: ${toolsUsed(blockOutput)})`, blockOutput);
  // An unchanged file alone proves nothing: the model may have stopped, or fumbled the patch, before
  // the hook ever ran. Require the hook's own deny text to have reached the harness.
  if (!blockOutput.includes("Breaking change to `contracts/user.json`")) {
    fail("the file is unchanged, but there's no sign the Kingpost hook is what stopped the edit", blockOutput.slice(-3000));
  }

  // 2. Control: with KINGPOST_FORCE=1 the same request must go through.
  const [cmd2, args2, opts2] = harnessCommand(true);
  const forced = await runAsync(cmd2, args2, { cwd: dir, ...opts2 });
  if (!fakeMode) console.log(costSummary((forced.stdout ?? "") + (forced.stderr ?? "")));
  const afterForce = readFileSync(join(dir, CONTRACT), "utf8");
  console.log(`[${harness}] force run exit=${forced.status}, tools used: ${toolsUsed((forced.stdout ?? "") + (forced.stderr ?? ""))}\n${(forced.stdout ?? "").slice(-800)}`);
  if (afterForce === ORIGINAL || JSON.parse(afterForce).properties.age !== undefined) {
    fail("control run: with KINGPOST_FORCE=1 the edit still didn't happen, so the block run proves nothing", (forced.stdout ?? "") + (forced.stderr ?? ""));
  }

  console.log(`PASS [${harness}, ${fakeMode ? "fake" : "real"} model]: breaking edit blocked, and allowed with KINGPOST_FORCE=1`);
} catch (e) {
  reportFailure(e);
  process.exitCode = 1;
} finally {
  await deleteProject();
  await fake?.close();
  rmSync(dir, { recursive: true, force: true });
  if (codexHome) rmSync(codexHome, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
