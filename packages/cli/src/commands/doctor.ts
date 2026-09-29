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
  checks.push(checkCodexPluginSupport());
  checks.push(checkCodexPlugin());
  checks.push(checkCodexMcp());
  checks.push(checkCodexResolvedPathHooks(cwd));
  checks.push(checkCodexAppServerDaemon());

  for (const c of checks) {
    if (c.informational) console.log(`ℹ ${c.label}: ${c.detail}`);
    else console.log(c.ok ? `✓ ${c.label}` : `✗ ${c.label}: ${c.detail}`);
  }
}
