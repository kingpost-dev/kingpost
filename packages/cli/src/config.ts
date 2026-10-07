import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_SERVER_URL = "https://app.kingpost.dev";

export interface ProjectConfig {
  serverUrl: string;
  projectId: string;
  agentId?: string;
  claims?: string[];
  lastKnownChangedContractPaths?: string[];
  lastKnownOverlappingClaimPaths?: string[];
  /** contract path -> sha256 of the content Kingpost last saw in sync with the registry, so a shell command that
   * rewrites a contract can be told apart from "nothing changed" without a network call. */
  contractHashes?: Record<string, string>;
}

export interface Credentials {
  [projectId: string]: { token: string };
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".kingpost.json");
}

export function readProjectConfig(cwd: string): ProjectConfig | null {
  const p = projectConfigPath(cwd);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`kingpost: ${p} contains invalid JSON, treating as absent (${e instanceof Error ? e.message : e})`);
    return null;
  }
}

export function writeProjectConfig(cwd: string, config: ProjectConfig): void {
  writeFileSync(projectConfigPath(cwd), JSON.stringify(config, null, 2) + "\n");
}

function credentialsDir(): string {
  return join(os.homedir(), ".config", "kingpost");
}

function credentialsPath(): string {
  return join(credentialsDir(), "credentials.json");
}

export function readCredentials(): Credentials {
  const p = credentialsPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`kingpost: ${p} contains invalid JSON, treating as absent (${e instanceof Error ? e.message : e})`);
    return {};
  }
}

export function writeCredential(projectId: string, token: string): void {
  const dir = credentialsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const creds = readCredentials();
  creds[projectId] = { token };
  writeFileSync(credentialsPath(), JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
}

export function getToken(projectId: string): string | null {
  return readCredentials()[projectId]?.token ?? null;
}

const AGENTS_MD_MARKER_START = "<!-- kingpost:start -->";
const AGENTS_MD_MARKER_END = "<!-- kingpost:end -->";

/** Files Kingpost writes machine-specific content into: an agent identity, or absolute paths into one person's
 * install. Committing them gives teammates paths that don't exist on their machines, so they're ignored by default.
 * Specific files, not whole `.claude/` or `.codex/` directories, so something a team deliberately shares there
 * (custom commands, say) is never hidden. */
export const GITIGNORE_ENTRIES = [".kingpost.json", ".mcp.json", ".claude/settings.json", ".codex/hooks.json", ".codex/config.toml"];

function insideGitRepo(cwd: string): boolean {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Adds the per-machine Kingpost files to .gitignore (creating it if needed). Does nothing outside a git repo, skips
 * entries already present or covered by a broader pattern the user has (e.g. `.claude/`), and never duplicates, so
 * it is safe to run repeatedly. Returns the entries it added. Note it can't un-track a file the repo already commits. */
export function upsertGitignoreEntries(cwd: string): string[] {
  if (!insideGitRepo(cwd)) return [];
  const p = join(cwd, ".gitignore");
  const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
  const present = new Set(existing.split("\n").map((l) => l.trim().replace(/^\//, "")));
  const covered = (entry: string) => {
    if (present.has(entry)) return true;
    const dir = entry.includes("/") ? entry.slice(0, entry.indexOf("/")) : undefined;
    return !!dir && (present.has(`${dir}/`) || present.has(dir));
  };
  const missing = GITIGNORE_ENTRIES.filter((e) => !covered(e));
  if (missing.length === 0) return [];
  const prefix = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(p, `${existing}${prefix}# Kingpost: per-machine state (agent identity, absolute paths into this install)\n${missing.join("\n")}\n`);
  return missing;
}

/** Whether AGENTS.md holds a Kingpost block, and if so whether it matches `block` (the current wording). */
export function agentsMdBlockStatus(cwd: string, block: string): "missing" | "current" | "outdated" {
  const p = join(cwd, "AGENTS.md");
  if (!existsSync(p)) return "missing";
  const existing = readFileSync(p, "utf8");
  const startIdx = existing.indexOf(AGENTS_MD_MARKER_START);
  const endIdx = existing.indexOf(AGENTS_MD_MARKER_END);
  if (startIdx === -1 || endIdx === -1) return "missing";
  const inside = existing.slice(startIdx + AGENTS_MD_MARKER_START.length, endIdx).trim();
  return inside === block.trim() ? "current" : "outdated";
}

export function upsertAgentsMdBlock(cwd: string, block: string): void {
  const p = join(cwd, "AGENTS.md");
  const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
  const wrapped = `${AGENTS_MD_MARKER_START}\n${block}\n${AGENTS_MD_MARKER_END}`;
  const startIdx = existing.indexOf(AGENTS_MD_MARKER_START);
  const endIdx = existing.indexOf(AGENTS_MD_MARKER_END);
  let next: string;
  if (startIdx !== -1 && endIdx !== -1) {
    next = existing.slice(0, startIdx) + wrapped + existing.slice(endIdx + AGENTS_MD_MARKER_END.length);
  } else {
    next = existing.length > 0 ? existing.trimEnd() + "\n\n" + wrapped + "\n" : wrapped + "\n";
  }
  writeFileSync(p, next);
}
