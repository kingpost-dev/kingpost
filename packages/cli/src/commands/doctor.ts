import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readProjectConfig, getToken } from "../config.js";

interface Check {
  label: string;
  ok: boolean;
  detail?: string;
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

function checkCodexPlugin(): Check {
  const cacheDir = join(homedir(), ".codex", "plugins", "cache", "kingpost");
  return existsSync(cacheDir)
    ? { label: "Codex plugin installed", ok: true }
    : { label: "Codex plugin installed", ok: false, detail: "not found in ~/.codex/plugins/cache — run 'codex plugin marketplace add kingpost-dev/kingpost' then 'codex plugin add kingpost@kingpost'" };
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
  checks.push(checkCodexPlugin());

  for (const c of checks) {
    console.log(c.ok ? `✓ ${c.label}` : `✗ ${c.label}: ${c.detail}`);
  }
}
