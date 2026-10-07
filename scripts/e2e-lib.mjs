// Shared plumbing for the real-harness e2e scripts: running the REAL Claude Code / Codex CLIs, with either
// their real model or the scripted stand-in (scripts/fake-model), against the real Kingpost server.
//
// Modes (KINGPOST_E2E_MODEL):
//   fake (default)  the harness talks to a local scripted model: free, deterministic, no API key. Everything
//                   Kingpost does (hooks, blocking, MCP) still runs for real inside the real harness.
//   real            the harness uses its real model and API key (ANTHROPIC_API_KEY / OPENAI_API_KEY). The only
//                   mode that can notice a real model choosing a shell write over the edit tool.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const root = resolve(import.meta.dirname, "..");
export const cliEntry = join(root, "packages/cli/dist/index.js");
export const server = process.env.KINGPOST_E2E_SERVER ?? "https://app.kingpost.dev";
export const fakeMode = process.env.KINGPOST_E2E_MODEL !== "real";
// KINGPOST_E2E_CLI=installed drives the `kingpost` binary on PATH (what `npm i -g kingpost` gives a user), not the
// repo's build: that's the only way to exercise the published package and its install paths.
export const installedCli = process.env.KINGPOST_E2E_CLI === "installed";

// Failures throw so each script's `finally` cleanup always runs (an exit would skip it and leak the
// throwaway project); the script's catch reports and sets the exit code.
export class Failure extends Error {
  constructor(msg, detail) {
    super(msg);
    this.detail = detail;
  }
}
export function fail(msg, detail) {
  throw new Failure(msg, detail);
}

export function reportFailure(label, e) {
  if (!(e instanceof Failure)) {
    console.error(`FAIL [${label}]: unexpected error: ${e instanceof Error ? e.stack : e}`);
    return;
  }
  console.error(`FAIL [${label}]: ${e.message}`);
  if (e.detail) console.error(String(e.detail).slice(-8000));
  // The hook swallows its own errors into this log (it must never break the agent), so a silent
  // fail-open shows up here and nowhere else.
  const log = join(homedir(), ".kingpost", "log");
  if (existsSync(log)) console.error(`--- ${log} (tail) ---\n${readFileSync(log, "utf8").slice(-3000)}`);
}

// On Windows the harness CLIs are .cmd shims, which only run through a shell, and a shell does no
// argument quoting. Prompts deliberately have no double quotes or shell metacharacters, so wrapping
// whitespace-containing arguments in double quotes is enough.
const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);

export const runSync = (cmd, args, { cwd, env = {}, timeout = 240_000 } = {}) =>
  process.platform === "win32"
    ? spawnSync([cmd, ...args.map(quote)].join(" "), { cwd, encoding: "utf8", timeout, shell: true, env: { ...process.env, ...env } })
    : spawnSync(cmd, args, { cwd, encoding: "utf8", timeout, env: { ...process.env, ...env } });

// Async variant for harness runs: the scripted model server lives in THIS process, and a synchronous spawn
// would block the event loop so the server could never answer (the harness would hang).
export const runAsync = (cmd, args, { cwd, env = {}, timeout = 240_000 } = {}) =>
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

// The CLI ships as one bundle, so talk to the REST API directly. Retries ride out a cold server.
export async function api(project, method, path, body) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`${project.config.serverUrl}/api/projects/${project.config.projectId}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${project.token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
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

// Best-effort cleanup: never masks the test result. A server that predates DELETE /api/projects/:id answers
// 404/405, in which case the project is simply left behind.
export async function deleteProject(label, project) {
  if (!project) return;
  try {
    const res = await fetch(`${project.config.serverUrl}/api/projects/${project.config.projectId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${project.token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) console.warn(`[${label}] couldn't delete the throwaway project ${project.config.projectId} (HTTP ${res.status})`);
  } catch (e) {
    console.warn(`[${label}] couldn't delete the throwaway project: ${e instanceof Error ? e.message : e}`);
  }
}

/** Runs one `kingpost <args>` command (init, join, doctor, update...) the way the current mode says to. */
export const runKingpost = (args, opts) => (installedCli ? runSync("kingpost", args, opts) : runSync("node", [cliEntry, ...args], opts));

/** Reads the project a directory was init'd/joined into, plus its token from the credentials file. */
export function loadProject(dir) {
  const config = JSON.parse(readFileSync(join(dir, ".kingpost.json"), "utf8"));
  const token = JSON.parse(readFileSync(join(homedir(), ".config", "kingpost", "credentials.json"), "utf8"))[config.projectId]?.token;
  if (!config.projectId || !token) fail("no project config and credential in " + dir);
  return { config, token };
}

/** A real (symlink- and 8.3-resolved) temp directory. On Windows runners tmpdir() is an 8.3 short path
 * (C:\Users\RUNNER~1\...) that Claude Code doesn't treat as inside the project. */
export const makeTempDir = (prefix) => realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));

// Codex only loads a project's .codex/hooks.json once the project is trusted (interactively that's the
// /hooks prompt). Each run gets its own CODEX_HOME with the project directories pre-trusted, so it is
// isolated from (and never edits) the caller's real Codex config.
export function prepareCodexHome(projectDirs, fakeUrl) {
  const home = makeTempDir("kp-e2e-codex-home-");
  const trust = projectDirs.map((d) => `[projects.${JSON.stringify(realpathSync(d))}]\ntrust_level = "trusted"\n`).join("");
  if (fakeUrl) {
    // Codex learns a model's tool set (freeform apply_patch, inlined MCP tools) from a model catalog, so the
    // fake model ships its own catalog entry, and a custom provider points the Responses API at the fake server.
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

/** The command line + environment to run one non-interactive agent turn.
 * opts: harness, prompt, dir, force (KINGPOST_FORCE), agentName (KINGPOST_AGENT), fake (scripted model
 * server), codexHome, mcp (let the agent call the Kingpost MCP tools unattended), shell (let Claude Code run
 * Bash; it is disabled otherwise so a model can't sidestep the edit tools by accident). */
export function harnessCommand({ harness, prompt, dir, force = false, agentName, fake, codexHome, mcp = false, shell = false }) {
  const env = {};
  if (force) env.KINGPOST_FORCE = "1";
  if (agentName) env.KINGPOST_AGENT = agentName;
  if (harness === "codex") {
    env.CODEX_HOME = codexHome;
    if (process.env.KINGPOST_E2E_DEBUG) env.RUST_LOG = "debug";
    if (fake) env.FAKE_KEY = "fake-key";
    return [
      "codex",
      [
        "exec", "--skip-git-repo-check", "--dangerously-bypass-hook-trust",
        // Codex refuses MCP tool calls it can't get approval for, and its own sandbox can't start on CI
        // runners (shell reads get refused). Both are throwaway-machine situations, so run unrestricted
        // there; locally keep the sandbox unless the scenario needs MCP.
        ...(mcp ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", process.env.CI ? "danger-full-access" : "workspace-write"]),
        prompt,
      ],
      { env },
    ];
  }
  if (fake) Object.assign(env, { ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: "fake-key", ANTHROPIC_AUTH_TOKEN: "" });
  return [
    "claude",
    [
      "-p", prompt, "--model", process.env.KINGPOST_E2E_CLAUDE_MODEL ?? "claude-haiku-4-5-20251001", "--max-turns", "12", "--permission-mode", "acceptEdits",
      // Claude Code won't connect to a project .mcp.json server until it's approved interactively, so hand it
      // the config explicitly and allow the server's tools.
      ...(mcp ? ["--mcp-config", join(dir, ".mcp.json"), "--strict-mcp-config", "--allowedTools", "mcp__kingpost"] : []),
      "--output-format", "stream-json", "--verbose",
      ...(shell ? ["--allowedTools", "Bash"] : ["--disallowedTools", "Bash"]),
    ],
    { env },
  ];
}

// Which tools did the agent actually use? A contract changed by a shell write is invisible to Kingpost,
// so "the edit wasn't blocked" means something different when the model went around the edit tool.
export function toolsUsed(harness, output) {
  const names = [...output.matchAll(/"type":"tool_use","id":"[^"]*","name":"([A-Za-z_]+)"/g)].map((m) => m[1]);
  if (harness === "codex") {
    if (/apply patch|apply_patch/i.test(output)) names.push("apply_patch");
    if (/\bexec\b|succeeded in \d+ms/.test(output)) names.push("shell");
  }
  return [...new Set(names)].join(", ") || "(none detected)";
}

// Claude reports its own USD cost; Codex only reports tokens.
export function costSummary(harness, output) {
  const usd = [...output.matchAll(/"total_cost_usd":([0-9.]+)/g)].map((m) => Number(m[1]));
  const tokens = [...output.matchAll(/tokens used\s*\n?\s*([0-9,]+)/g)].map((m) => m[1]);
  return usd.length ? `COST [${harness}] $${usd.at(-1).toFixed(4)}` : tokens.length ? `COST [${harness}] ${tokens.at(-1)} tokens` : `COST [${harness}] unknown`;
}
