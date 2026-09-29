import { existsSync } from "node:fs";
import { DEFAULT_SERVER_URL, projectConfigPath, readProjectConfig, writeProjectConfig, writeCredential, upsertAgentsMdBlock } from "../config.js";
import { createProject, ApiClient } from "../api.js";
import { scanRepo } from "../scan/scan-repo.js";
import { AGENTS_MD_BLOCK } from "./agents-md-block.js";
import { writeResolvedPathHooks } from "./resolved-path-hooks.js";
import { writeResolvedPathMcpConfig } from "./resolved-path-mcp.js";

export async function initCommand(name: string, opts: { serverUrl?: string; cwd?: string }) {
  const serverUrl = opts.serverUrl ?? DEFAULT_SERVER_URL;
  const cwd = opts.cwd ?? process.cwd();

  if (existsSync(projectConfigPath(cwd))) {
    const existing = readProjectConfig(cwd);
    if (existing) {
      console.error(`This directory is already initialized (project ${existing.projectId} on ${existing.serverUrl}). Remove .kingpost.json first if you really want to create a new project.`);
    } else {
      console.error(`.kingpost.json exists but is corrupted and could not be parsed. Fix or remove it before running 'kingpost init' again — do not proceed without checking whether it holds a real project link.`);
    }
    process.exitCode = 1;
    return;
  }

  const { projectId, token } = await createProject(serverUrl, name);

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

  console.log(`Kingpost project "${name}" created.`);
  console.log(`Invite link:    ${serverUrl}/join/${projectId}#${token}`);
  console.log(`Dashboard:      ${serverUrl}/p/${projectId}#${token}`);
  console.log(`Next: install the plugin for your own harness (see the README's "Starting a new project" section for the exact commands), then run 'kingpost doctor' to confirm it's working.`);
}
