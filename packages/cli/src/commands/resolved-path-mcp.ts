// Windows-safe fallback MCP server registration.
//
// Same root cause as resolved-path-hooks.ts: the plugin manifests (plugins/claude-code/.mcp.json,
// plugins/codex/mcp.json) register the kingpost MCP server via a bare `kingpost` command, which
// depends on PATH resolution that's confirmed broken for hook subprocesses on Windows and is
// presumed broken here too, since whatever spawns the MCP server subprocess faces the same
// PATH-inheritance gap. Unlike hooks, MCP server config is not additive across scopes — both
// Claude Code and Codex resolve a server name to a single highest-precedence entry, so writing a
// project-scope entry here with fully resolved absolute paths is a clean *replacement* for that
// scope, not a second safety net running alongside the broken one.
//
// Claude Code: project-scope `.mcp.json` at the repo root outranks the plugin-provided server of
// the same name (confirmed via code.claude.com/docs/en/mcp).
//
// Codex: project-scope `.codex/config.toml` (walked upward from cwd) outranks the user-level
// `~/.codex/config.toml` that `codex mcp add` writes — BUT only for a project Codex has marked
// trusted; an untrusted project skips the project-scope layer entirely and falls back to the
// still-broken user-level entry. This is the same class of manual step as the already-documented
// `/hooks` trust requirement — don't assume this "just works" without that.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolvedEntryPath, readJsonObject } from "./resolved-path-hooks.js";

export function upsertClaudeMcpConfig(cwd: string, entryPath: string = resolvedEntryPath()): void {
  const path = join(cwd, ".mcp.json");
  const config = readJsonObject(path);
  const mcpServers = typeof config.mcpServers === "object" && config.mcpServers !== null ? (config.mcpServers as Record<string, unknown>) : {};
  mcpServers.kingpost = { command: process.execPath, args: [entryPath, "mcp"] };
  config.mcpServers = mcpServers;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildCodexMcpTable(command: string, args: string[]): string {
  const argsList = args.map((a) => `"${escapeTomlString(a)}"`).join(", ");
  return `[mcp_servers.kingpost]\ncommand = "${escapeTomlString(command)}"\nargs = [${argsList}]`;
}

/** Removes any existing `[mcp_servers.kingpost]` table from raw TOML text, from its header line
 * up to (but not including) the next line that starts with `[`, or EOF — whichever comes first.
 * No TOML library is a dependency here (matching doctor.ts's existing regex-based, read-only
 * check of this same table); since we only ever touch our own single named table, this is
 * simpler and safer than pulling in a full TOML parser just to write one table. */
function stripExistingKingpostTable(content: string): string {
  const headerRe = /^\[mcp_servers\.kingpost\]/m;
  const header = headerRe.exec(content);
  if (!header) return content;
  const start = header.index;

  const nextHeaderRe = /^\[/gm;
  nextHeaderRe.lastIndex = start + header[0].length;
  const next = nextHeaderRe.exec(content);
  const end = next ? next.index : content.length;

  return content.slice(0, start) + content.slice(end);
}

export function upsertCodexMcpConfig(cwd: string, entryPath: string = resolvedEntryPath()): void {
  const path = join(cwd, ".codex", "config.toml");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const withoutKingpost = stripExistingKingpostTable(existing).trimEnd();
  const table = buildCodexMcpTable(process.execPath, [entryPath, "mcp"]);
  const content = withoutKingpost ? `${withoutKingpost}\n\n${table}\n` : `${table}\n`;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Writes both harnesses' resolved-path MCP registration safety nets. Never throws — a failure
 * here (bad permissions, malformed existing JSON/TOML, etc.) is logged and swallowed so it can't
 * break `init`/`join`, matching how the rest of this CLI treats non-critical setup steps. */
export function writeResolvedPathMcpConfig(cwd: string): void {
  try {
    upsertClaudeMcpConfig(cwd);
  } catch (e) {
    console.error(`kingpost: couldn't write Claude Code's resolved-path MCP registration (${e instanceof Error ? e.message : e}) — MCP tools may silently fail to connect on Windows. Safe to ignore and re-run 'kingpost init'/'kingpost join' later.`);
  }
  try {
    upsertCodexMcpConfig(cwd);
  } catch (e) {
    console.error(`kingpost: couldn't write Codex's resolved-path MCP registration (${e instanceof Error ? e.message : e}) — MCP tools may silently fail to connect on Windows. Safe to ignore and re-run 'kingpost init'/'kingpost join' later.`);
  }
}
