// End-to-end check against a REAL agent harness (Claude Code or Codex) and the real Kingpost server:
// a breaking edit to a consumed contract must be blocked, and the same request with KINGPOST_FORCE=1
// must go through. The second run is the control: it proves the model WOULD make the edit, so the
// first run staying unchanged is the hook's doing and not the model declining on its own.
//
//   node scripts/e2e-real-harness.mjs <claude|codex>
//
// Needs the built CLI (npm run build), the harness binary on PATH, and its API key in the
// environment (ANTHROPIC_API_KEY / OPENAI_API_KEY). Creates a throwaway project on the server
// (KINGPOST_E2E_SERVER, default https://app.kingpost.dev); the API has no project delete.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const harness = process.argv[2];
if (harness !== "claude" && harness !== "codex") {
  console.error("usage: node scripts/e2e-real-harness.mjs <claude|codex>");
  process.exit(2);
}

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

function fail(msg, detail) {
  console.error(`FAIL [${harness}]: ${msg}`);
  if (detail) console.error(String(detail).slice(-8000));
  // The hook swallows its own errors into this log (it must never break the agent), so a silent
  // fail-open shows up here and nowhere else.
  const log = join(homedir(), ".kingpost", "log");
  if (existsSync(log)) console.error(`--- ${log} (tail) ---\n${readFileSync(log, "utf8").slice(-3000)}`);
  process.exit(1);
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
function prepareCodexHome(projectDir) {
  const home = mkdtempSync(join(tmpdir(), "kp-e2e-codex-home-"));
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
  writeFileSync(join(home, "config.toml"), `[projects.${JSON.stringify(realpathSync(projectDir))}]\ntrust_level = "trusted"\n`);
  return home;
}

// Claude reports its own USD cost; Codex only reports tokens.
function costSummary(output) {
  const usd = [...output.matchAll(/"total_cost_usd":([0-9.]+)/g)].map((m) => Number(m[1]));
  const tokens = [...output.matchAll(/tokens used\s*\n?\s*([0-9,]+)/g)].map((m) => m[1]);
  return usd.length ? `COST [${harness}] $${usd.at(-1).toFixed(4)}` : tokens.length ? `COST [${harness}] ${tokens.at(-1)} tokens` : `COST [${harness}] unknown`;
}

let codexHome;
function harnessCommand(force) {
  const env = force ? { KINGPOST_FORCE: "1" } : {};
  if (harness === "codex") { env.CODEX_HOME = codexHome; if (process.env.KINGPOST_E2E_DEBUG) env.RUST_LOG = "debug"; }
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

  if (harness === "codex") codexHome = prepareCodexHome(dir);
  const init = run("node", [cliEntry, "init", "--name", `e2e-${harness}-${Date.now()}`, "--server-url", server], { cwd: dir });
  if (init.status !== 0) fail("kingpost init failed", init.stdout + init.stderr);

  const config = JSON.parse(readFileSync(join(dir, ".kingpost.json"), "utf8"));
  const token = JSON.parse(readFileSync(join(homedir(), ".config", "kingpost", "credentials.json"), "utf8"))[config.projectId]?.token;
  if (!config.projectId || !token) fail("init didn't produce a project config and credential");
  const { contract } = await api(config, token, "PUT", "/contracts", { path: CONTRACT, content: ORIGINAL, updatedBy: "e2e", format: "json-schema" });
  await api(config, token, "POST", `/contracts/${contract.id}/consumers`, { path: "src/uses-user.ts", agentId: null, declared: true });

  // 1. Without the override the hook must block, leaving the file untouched.
  const [cmd, args, opts] = harnessCommand(false);
  const blocked = run(cmd, args, { cwd: dir, ...opts });
  const afterBlock = readFileSync(join(dir, CONTRACT), "utf8");
  const blockOutput = (blocked.stdout ?? "") + (blocked.stderr ?? "");
  if (process.env.KINGPOST_E2E_DEBUG) writeFileSync("/tmp/e2e-block-output.txt", blockOutput);
  console.log(`[${harness}] block run exit=${blocked.status}, tools used: ${toolsUsed(blockOutput)}\n${blockOutput.slice(-1500)}`);
  console.log(costSummary(blockOutput));
  if (afterBlock !== ORIGINAL) fail(`the breaking edit was NOT blocked: the contract changed on disk (tools used: ${toolsUsed(blockOutput)})`, blockOutput);
  // An unchanged file alone proves nothing: the model may have stopped, or fumbled the patch, before
  // the hook ever ran. Require the hook's own deny text to have reached the harness.
  if (!blockOutput.includes("Breaking change to `contracts/user.json`")) {
    fail("the file is unchanged, but there's no sign the Kingpost hook is what stopped the edit", blockOutput.slice(-3000));
  }

  // 2. Control: with KINGPOST_FORCE=1 the same request must go through.
  const [cmd2, args2, opts2] = harnessCommand(true);
  const forced = run(cmd2, args2, { cwd: dir, ...opts2 });
  console.log(costSummary((forced.stdout ?? "") + (forced.stderr ?? "")));
  const afterForce = readFileSync(join(dir, CONTRACT), "utf8");
  console.log(`[${harness}] force run exit=${forced.status}, tools used: ${toolsUsed((forced.stdout ?? "") + (forced.stderr ?? ""))}\n${(forced.stdout ?? "").slice(-800)}`);
  if (afterForce === ORIGINAL || JSON.parse(afterForce).properties.age !== undefined) {
    fail("control run: with KINGPOST_FORCE=1 the edit still didn't happen, so the block run proves nothing", (forced.stdout ?? "") + (forced.stderr ?? ""));
  }

  console.log(`PASS [${harness}]: breaking edit blocked, and allowed with KINGPOST_FORCE=1`);
} finally {
  rmSync(dir, { recursive: true, force: true });
  if (codexHome) rmSync(codexHome, { recursive: true, force: true });
}
