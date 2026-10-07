// What a brand-new user hits in their first ten minutes, on a clean machine: install kingpost, `init` a project,
// `join` it from a second directory, run `doctor`, run `update`. Meant to run against the PUBLISHED package
// (KINGPOST_E2E_CLI=installed, after `npm i -g kingpost`), because the install paths it writes into hook and MCP
// configs (absolute paths into the global install, Windows `commandWindows` overrides) only exist there.
//
//   node scripts/e2e-install.mjs
//
// Needs `claude` and `codex` on PATH so doctor can see both. Creates a throwaway project on the server and
// deletes it again. Set KINGPOST_E2E_EXPECT_VERSION to assert which version is installed.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { deleteProject, fail, installedCli, loadProject, makeTempDir, reportFailure, runKingpost, server } from "./e2e-lib.mjs";

const label = "install";
const dirOwner = makeTempDir("kp-e2e-install-owner-");
const dirJoiner = makeTempDir("kp-e2e-install-joiner-");
let project;

function expect(cond, msg, detail) {
  if (!cond) fail(msg, detail);
  console.log(`  ok: ${msg.replace(/^expected /, "")}`);
}

const out = (r) => (r.stdout ?? "") + (r.stderr ?? "");
const read = (dir, rel) => readFileSync(join(dir, rel), "utf8");

// Every absolute path a hook or MCP config tells a harness to run, so we can check each one actually exists.
function referencedPaths(text) {
  return [...text.matchAll(/(?:[A-Za-z]:\\\\|\/)[^"'\n,]*?(?:index\.js|node(?:\.exe)?)(?=["'\s,\]]|$)/g)].map((m) => m[0].replace(/\\\\/g, "\\"));
}

// What `kingpost doctor` is allowed to complain about on a machine that has never had the plugins installed or a
// session run: those are real, expected "not yet" states. Anything else red is a bug.
const EXPECTED_RED = [
  "agent registered", // no session has run yet
  "Claude Code plugin installed",
  "Codex plugin installed",
  "Codex MCP server registered", // `codex mcp add` hasn't been run
  "Claude Code approved the project's MCP server", // Claude Code asks interactively, on first run
];
const REQUIRED_GREEN = [
  "config",
  "credentials",
  "server reachable",
  "AGENTS.md Kingpost block",
  "Claude Code resolved-path hooks (Windows safety net)",
  "Claude Code resolved-path MCP registration (Windows safety net)",
  "Codex resolved-path MCP registration (Windows safety net)",
  "Codex resolved-path hooks (Windows safety net)",
  "Codex CLI supports 'plugin' subcommand",
];

try {
  console.log(`[${label}] mode: ${installedCli ? "installed `kingpost` on PATH" : "repo build"}; server ${server}`);

  const version = out(runKingpost(["--version"], { cwd: dirOwner })).trim();
  console.log(`  kingpost --version -> ${version}`);
  expect(/^\d+\.\d+\.\d+/.test(version), "expected `kingpost --version` to print a version", version);
  if (process.env.KINGPOST_E2E_EXPECT_VERSION) {
    expect(version === process.env.KINGPOST_E2E_EXPECT_VERSION, `expected the installed version to be ${process.env.KINGPOST_E2E_EXPECT_VERSION}`, version);
  }

  const init = runKingpost(["init", "--name", `e2e-install-${Date.now()}`, "--server-url", server], { cwd: dirOwner });
  expect(init.status === 0, "expected `kingpost init` to succeed on a clean machine", out(init));
  project = loadProject(dirOwner);
  const link = out(init).match(/Invite link:\s+(\S+)/)?.[1];
  expect(link && link.includes("/join/") && link.includes("#"), "expected init to print an invite link", out(init));
  expect(/Dashboard:\s+\S+\/p\//.test(out(init)), "expected init to print a dashboard link", out(init));

  for (const rel of [".kingpost.json", "AGENTS.md", ".claude/settings.json", ".codex/hooks.json", ".codex/config.toml", ".mcp.json"]) {
    expect(existsSync(join(dirOwner, rel)), `expected init to write ${rel}`);
  }
  expect(read(dirOwner, "AGENTS.md").includes("<!-- kingpost:start -->"), "expected AGENTS.md to hold the Kingpost block");
  if (process.platform === "win32") {
    expect(read(dirOwner, ".codex/hooks.json").includes("commandWindows"), "expected the Codex hooks to carry a Windows `commandWindows` override", read(dirOwner, ".codex/hooks.json"));
  }

  // The configs point at absolute paths inside THIS install. If any of those don't exist, the harness silently runs nothing.
  const configs = [".claude/settings.json", ".codex/hooks.json", ".mcp.json", ".codex/config.toml"].map((rel) => read(dirOwner, rel)).join("\n");
  const paths = [...new Set(referencedPaths(configs))];
  expect(paths.length > 0, "expected the hook and MCP configs to reference absolute paths", configs.slice(0, 1500));
  const missing = paths.filter((p) => !existsSync(p));
  expect(missing.length === 0, "expected every path in the hook and MCP configs to exist", `missing: ${missing.join(", ")}\nchecked: ${paths.join(", ")}`);

  const joined = runKingpost(["join", link, "--name", "joiner"], { cwd: dirJoiner });
  expect(joined.status === 0, "expected `kingpost join <invite link>` to succeed from a second directory", out(joined));
  expect(existsSync(join(dirJoiner, ".mcp.json")) && existsSync(join(dirJoiner, ".codex/hooks.json")), "expected join to write the same hook and MCP configs");
  expect(loadProject(dirJoiner).config.projectId === project.config.projectId, "expected join to link the second directory to the same project");

  // doctor, on a machine that has the project but none of the optional plugin steps yet.
  const doctor = runKingpost(["doctor"], { cwd: dirOwner });
  console.log(out(doctor));
  const lines = out(doctor).split("\n");
  const status = (name) => {
    const hit = lines.find((l) => l.replace(/^[✓✗ℹ]\s*/, "").startsWith(name));
    return hit ? hit[0] : null;
  };
  for (const name of REQUIRED_GREEN) expect(status(name) === "✓", `expected doctor to show "${name}" green`, out(doctor));
  const unexpectedRed = lines.filter((l) => l.startsWith("✗") && !EXPECTED_RED.some((name) => l.slice(1).trim().startsWith(name)));
  expect(unexpectedRed.length === 0, "expected doctor to show nothing red except the not-yet-installed plugin steps", unexpectedRed.join("\n") + "\n" + out(doctor));

  const update = runKingpost(["update"], { cwd: dirOwner });
  expect(update.status === 0 && out(update).includes("already up to date"), "expected `kingpost update` on a fresh project to report the AGENTS.md block already up to date", out(update));

  console.log(`PASS [${label}]: install, init, join, doctor and update all behave on a clean machine`);
} catch (e) {
  reportFailure(label, e);
  process.exitCode = 1;
} finally {
  await deleteProject(label, project);
  rmSync(dirOwner, { recursive: true, force: true });
  rmSync(dirJoiner, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
