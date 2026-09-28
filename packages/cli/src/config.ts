import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

export const DEFAULT_SERVER_URL = "https://app.kingpost.dev";

export interface ProjectConfig {
  serverUrl: string;
  projectId: string;
  agentId?: string;
  claims?: string[];
  lastKnownChangedContractPaths?: string[];
  lastKnownOverlappingClaimPaths?: string[];
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
