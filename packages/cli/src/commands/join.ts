import { execSync } from "node:child_process";
import { writeProjectConfig, writeCredential, upsertAgentsMdBlock } from "../config.js";
import { AGENTS_MD_BLOCK } from "./agents-md-block.js";
import { writeResolvedPathHooks } from "./resolved-path-hooks.js";
import { writeResolvedPathMcpConfig } from "./resolved-path-mcp.js";
import { ApiClient } from "../api.js";
import { scanRepo } from "../scan/scan-repo.js";

function parseInviteLink(link: string): { serverUrl: string; projectId: string; token: string } {
  const url = new URL(link);
  const token = url.hash.replace(/^#/, "");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "join" || !parts[1] || !token) {
    throw new Error(`Not a valid kingpost invite link: ${link}`);
  }
  const projectId = parts[1];
  return { serverUrl: `${url.protocol}//${url.host}`, projectId, token };
}

export function which(bin: string): boolean {
  try {
    const probe = process.platform === "win32" ? `where ${bin}` : `command -v ${bin}`;
    execSync(probe, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function joinCommand(link: string, opts: { name: string; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  const { serverUrl, projectId, token } = parseInviteLink(link);

  writeProjectConfig(cwd, { serverUrl, projectId });
  writeCredential(projectId, token);
  upsertAgentsMdBlock(cwd, AGENTS_MD_BLOCK);
  writeResolvedPathHooks(cwd);
  writeResolvedPathMcpConfig(cwd);

  // Initial full-repo scan for derived consumer relationships. No agent is registered yet at this
  // point, so relationships are recorded with a null agentId. scanRepo never throws, but guard
  // anyway — a failed scan must never fail setup.
  try {
    const count = await scanRepo(cwd, new ApiClient(serverUrl, projectId, token), null);
    if (count > 0) console.log(`Detected ${count} existing contract consumer relationship(s) from imports.`);
  } catch {
    // Never block setup on the scan.
  }

  console.log(`Joined project ${projectId} as ${opts.name}.`);
  console.log(`Dashboard: ${serverUrl}/p/${projectId}#${token}`);

  const hasClaude = which("claude");
  const hasCodex = which("codex");

  if (hasClaude) {
    console.log(`\nClaude Code found. Install the plugin with:`);
    console.log(`  claude plugin marketplace add kingpost-dev/kingpost`);
    console.log(`  claude plugin install kingpost@kingpost --scope project`);
  }
  if (hasCodex) {
    console.log(`\nCodex found. Install the plugin with:`);
    console.log(`  codex plugin marketplace add kingpost-dev/kingpost`);
    console.log(`  codex plugin add kingpost@kingpost`);
    console.log(`  codex mcp add kingpost -- kingpost mcp`);
    console.log(`  (then run /hooks in a Codex session to trust the kingpost hooks)`);
  }
  if (!hasClaude && !hasCodex) {
    console.log(`\nNeither 'claude' nor 'codex' was found on PATH. Install one, then re-run 'kingpost join'.`);
  }
}
