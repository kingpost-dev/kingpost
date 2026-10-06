import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { readProjectConfig, getToken } from "../config.js";
import { CLAUDE_HOOK_EVENTS, CODEX_HOOK_EVENTS, isKingpostClaudeHook, isKingpostCodexHook } from "./resolved-path-hooks.js";
import { codexAppServerSocketPath } from "../codex-rpc.js";

interface Check {
  label: string;
  ok: boolean;
  detail?: string;
  // Best-effort/experimental checks whose absence is normal/expected, not a bug — rendered
  // neutrally instead of as a ✓/✗ pass-fail.
  informational?: boolean;
}

async function checkServer(serverUrl: string): Promise<Check> {
  try {
    const res = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
    return { label: "server reachable", ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (e) {
    return { label: "server reachable", ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

function checkClaudePlugin(cwd: string): Check {
  for (const file of [".claude/settings.local.json", ".claude/settings.json"]) {
    const p = join(cwd, file);
    if (!existsSync(p)) continue;
    try {
      const json = JSON.parse(readFileSync(p, "utf8"));
      const enabled = json.enabledPlugins ?? {};
      if (Object.keys(enabled).some((k) => k.startsWith("kingpost"))) {
        return { label: "Claude Code plugin installed", ok: true };
      }
    } catch {
      // fall through to "not found"
    }
  }
  return { label: "Claude Code plugin installed", ok: false, detail: "not found in .claude/settings*.json — run 'claude plugin install kingpost@kingpost --scope project'" };
}

// The plugin's own hooks/hooks.json invokes a bare `kingpost` on PATH, which silently no-ops on
// Windows (see resolved-path-hooks.ts for why). `kingpost init`/`kingpost join` also write a
// second, resolved-absolute-path hook config as a safety net — check that it's actually there.
function hasKingpostHookEntry(hooksByEvent: unknown, event: string, isOwn: (hook: unknown, event: string) => boolean): boolean {
  const groups = typeof hooksByEvent === "object" && hooksByEvent !== null ? (hooksByEvent as Record<string, unknown>)[event] : undefined;
  if (!Array.isArray(groups)) return false;
  return groups.some((g) => {
    const hooks = typeof g === "object" && g !== null ? (g as Record<string, unknown>).hooks : undefined;
    return Array.isArray(hooks) && hooks.some((h) => isOwn(h, event));
  });
}

function checkClaudeResolvedPathHooks(cwd: string): Check {
  const label = "Claude Code resolved-path hooks (Windows safety net)";
  const p = join(cwd, ".claude", "settings.json");
  const detail = "missing or incomplete in .claude/settings.json — run 'kingpost init' or 'kingpost join'";
  if (!existsSync(p)) return { label, ok: false, detail };
  try {
    const settings = JSON.parse(readFileSync(p, "utf8"));
    const ok = CLAUDE_HOOK_EVENTS.every(({ event }) => hasKingpostHookEntry(settings.hooks, event, isKingpostClaudeHook));
    return { label, ok, detail: ok ? undefined : detail };
  } catch {
    return { label, ok: false, detail };
  }
}

function checkCodexResolvedPathHooks(cwd: string): Check {
  const label = "Codex resolved-path hooks (Windows safety net)";
  const p = join(cwd, ".codex", "hooks.json");
  const detail = "missing or incomplete in .codex/hooks.json — run 'kingpost init' or 'kingpost join'";
  if (!existsSync(p)) return { label, ok: false, detail };
  try {
    const config = JSON.parse(readFileSync(p, "utf8"));
    const ok = CODEX_HOOK_EVENTS.every(({ event }) => hasKingpostHookEntry(config.hooks, event, isKingpostCodexHook));
    return { label, ok, detail: ok ? undefined : detail };
  } catch {
    return { label, ok: false, detail };
  }
}

// The plugin's own MCP manifests (.mcp.json / mcp.json) register the kingpost MCP server via a
// bare `kingpost` command, which is presumed broken on Windows for the same PATH-inheritance
// reason as the hooks above. `kingpost init`/`kingpost join` also write a project-scope override
// with resolved absolute paths — check it's actually there. This only checks the file's shape,
// not that Claude Code is actually using it (project-scope `.mcp.json` always outranks the
// plugin's entry by name, so no separate "which one wins" check is needed here).
function checkClaudeMcpConfig(cwd: string): Check {
  const label = "Claude Code resolved-path MCP registration (Windows safety net)";
  const p = join(cwd, ".mcp.json");
  const detail = "missing or incomplete .mcp.json — run 'kingpost init' or 'kingpost join'";
  if (!existsSync(p)) return { label, ok: false, detail };
  try {
    const config = JSON.parse(readFileSync(p, "utf8"));
    const entry = config?.mcpServers?.kingpost;
    const ok = typeof entry?.command === "string" && Array.isArray(entry.args) && entry.args[entry.args.length - 1] === "mcp";
    return { label, ok, detail: ok ? undefined : detail };
  } catch {
    return { label, ok: false, detail };
  }
}

const CLAUDE_MCP_APPROVAL_DETAIL =
  "Claude Code hasn't approved the project's .mcp.json server yet, so its MCP tools won't connect — run 'claude' in this directory and approve the kingpost MCP server when prompted";

/** Reads the output of `claude mcp get kingpost`. Claude Code won't connect to a project-scope
 * `.mcp.json` server until the user approves it, and reports that as "Pending approval". Returns
 * null when the output says nothing about approval (approved, or an unfamiliar format) so an
 * inconclusive answer never shows up as a failure. */
export function parseClaudeMcpApproval(output: string): Check | null {
  const label = "Claude Code approved the project's MCP server";
  if (/pending approval/i.test(output)) return { label, ok: false, detail: CLAUDE_MCP_APPROVAL_DETAIL };
  if (/status:/i.test(output)) return { label, ok: true };
  return null;
}

// File-shape checks above can't see this: the entry can be perfectly written and still never run.
// Asks Claude Code itself (its own `mcp get` is the only authoritative source for approval state);
// any failure to ask (no `claude` on PATH, timeout) just skips the check.
function checkClaudeMcpApproval(cwd: string): Check | null {
  if (!existsSync(join(cwd, ".mcp.json"))) return null;
  try {
    const output = execSync("claude mcp get kingpost", { cwd, encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
    return parseClaudeMcpApproval(output);
  } catch {
    return null;
  }
}

// Same as checkClaudeMcpConfig, but for Codex's project-scope `.codex/config.toml`. Unlike the
// Claude Code case, this project-scope override only takes effect if Codex has the project
// marked trusted — an untrusted project skips the project-scope layer entirely and falls back to
// the still-broken user-level `~/.codex/config.toml` entry (same class of manual step as the
// `/hooks` trust requirement documented elsewhere). This check only verifies the file content is
// correct, not that Codex actually trusts the project — that can't be checked from here.
function checkCodexProjectMcp(cwd: string): Check {
  const label = "Codex resolved-path MCP registration (Windows safety net)";
  const p = join(cwd, ".codex", "config.toml");
  const detail = "missing or incomplete in .codex/config.toml — run 'kingpost init' or 'kingpost join' (also requires the project to be trusted in Codex for this override to take effect)";
  if (!existsSync(p)) return { label, ok: false, detail };
  const content = readFileSync(p, "utf8");
  const ok = /^\[mcp_servers\.kingpost\]/m.test(content) && /^args = \[.*"mcp"\]\s*$/m.test(content);
  return { label, ok, detail: ok ? undefined : detail };
}

// Older Codex CLI versions (confirmed: v0.104.0) have no `plugin` subcommand at all — it was
// added later (confirmed present in v0.158.0) — so `codex plugin marketplace add ...` / `codex
// plugin add ...` fail outright, and hooks (which only ship via the plugin mechanism) never get
// installed. Detect this by checking Codex's own --help output for the `plugin` subcommand.
function checkCodexPluginSupport(): Check {
  const detail =
    "installed Codex CLI has no 'plugin' subcommand — upgrade Codex CLI for hooks, or fall back to 'codex mcp add kingpost -- kingpost mcp' for MCP tools only (no hooks)";
  try {
    const output = execSync("codex --help", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const ok = /\bplugin\b/.test(output);
    return { label: "Codex CLI supports 'plugin' subcommand", ok, detail: ok ? undefined : detail };
  } catch (e) {
    return {
      label: "Codex CLI supports 'plugin' subcommand",
      ok: false,
      detail: `couldn't run 'codex --help': ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// Experimental: `kingpost watch --harness codex` uses this daemon to deliver mid-task
// notifications directly into a running Codex thread. Its absence is common (many installs
// don't have it) and falls back gracefully to normal polling — so this is reported neutrally,
// not as a failure.
function checkCodexAppServerDaemon(): Check {
  const available = existsSync(codexAppServerSocketPath());
  return {
    label: "Codex app-server daemon",
    ok: true,
    informational: true,
    detail: available
      ? "available for mid-task notifications"
      : "not available — mid-task notifications will fall back to normal polling, this is expected on many installs",
  };
}

function checkCodexPlugin(): Check {
  const cacheDir = join(homedir(), ".codex", "plugins", "cache", "kingpost");
  return existsSync(cacheDir)
    ? { label: "Codex plugin installed", ok: true }
    : { label: "Codex plugin installed", ok: false, detail: "not found in ~/.codex/plugins/cache — run 'codex plugin marketplace add kingpost-dev/kingpost' then 'codex plugin add kingpost@kingpost'" };
}

// `codex plugin add` installs the plugin's mcp.json into the plugin cache but does not wire it
// into Codex's runtime MCP config — Codex only picks up servers registered via `codex mcp add`,
// which writes a `[mcp_servers.kingpost]` table into ~/.codex/config.toml. This is a separate,
// explicit step (documented in `join`'s Codex instructions); check for it directly rather than
// assuming plugin install implies MCP registration.
//
// Substring-matches the exact format `codex mcp add` writes today (confirmed empirically).
// Not a general TOML-equivalence check — a hand-edited config.toml with different
// spacing/casing could false-negative here. Good enough for the tool's own generated output.
function checkCodexMcp(): Check {
  const detail = "run 'codex mcp add kingpost -- kingpost mcp'";
  const configPath = join(homedir(), ".codex", "config.toml");
  if (!existsSync(configPath)) {
    return { label: "Codex MCP server registered", ok: false, detail };
  }
  const content = readFileSync(configPath, "utf8");
  const ok = /^\[mcp_servers\.kingpost\]/m.test(content);
  return { label: "Codex MCP server registered", ok, detail: ok ? undefined : detail };
}

export async function doctorCommand(cwd: string = process.cwd()): Promise<void> {
  const checks: Check[] = [];

  const config = readProjectConfig(cwd);
  checks.push({
    label: "config",
    ok: !!config,
    detail: config ? undefined : "no .kingpost.json found — run 'kingpost init' or 'kingpost join'",
  });

  if (config) {
    const token = getToken(config.projectId);
    checks.push({ label: "credentials", ok: !!token, detail: token ? undefined : "no token in ~/.config/kingpost/credentials.json" });
    checks.push(await checkServer(config.serverUrl));
    checks.push({ label: "agent registered", ok: !!config.agentId, detail: config.agentId ? undefined : "no agentId yet — will register on next hook/tool call" });
  }

  checks.push(checkClaudePlugin(cwd));
  checks.push(checkClaudeResolvedPathHooks(cwd));
  checks.push(checkClaudeMcpConfig(cwd));
  const approval = checkClaudeMcpApproval(cwd);
  if (approval) checks.push(approval);
  checks.push(checkCodexPluginSupport());
  checks.push(checkCodexPlugin());
  checks.push(checkCodexMcp());
  checks.push(checkCodexProjectMcp(cwd));
  checks.push(checkCodexResolvedPathHooks(cwd));
  checks.push(checkCodexAppServerDaemon());

  for (const c of checks) {
    if (c.informational) console.log(`ℹ ${c.label}: ${c.detail}`);
    else console.log(c.ok ? `✓ ${c.label}` : `✗ ${c.label}: ${c.detail}`);
  }
}
