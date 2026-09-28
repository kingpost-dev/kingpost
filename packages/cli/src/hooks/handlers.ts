import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { readProjectConfig, writeProjectConfig, getToken, type ProjectConfig } from "../config.js";
import { ApiClient } from "../api.js";
import { renderBrief, deltaIsEmpty, claimsOverlap, type Harness, type Delta } from "@kingpost/protocol";
import type { HookInput } from "./parse.js";
import { TEAMMATE_LABEL, renderDeltaLines } from "../delta-format.js";

function isContractPath(path: string | undefined): boolean {
  return !!path && path.startsWith("contracts/");
}

interface AgentContext {
  client: ApiClient;
  agentId: string;
  config: ProjectConfig;
}

async function ensureAgent(cwd: string, harness: Harness): Promise<AgentContext | null> {
  const config = readProjectConfig(cwd);
  if (!config) return null;
  const token = getToken(config.projectId);
  if (!token) return null;

  const client = new ApiClient(config.serverUrl, config.projectId, token);
  if (config.agentId) return { client, agentId: config.agentId, config };

  const userName = process.env.KINGPOST_AGENT ?? process.env.USER ?? hostname();
  const { agent } = await client.registerAgent({ userName, harness, cwd });
  const updated = { ...config, agentId: agent.id };
  writeProjectConfig(cwd, updated);
  return { client, agentId: agent.id, config: updated };
}

/** Fetches the delta, caches the parts PreToolUse needs (WITHOUT another network call), and returns it. */
async function fetchAndCacheDelta(ctx: AgentContext, cwd: string): Promise<Delta> {
  const { delta } = await ctx.client.getDelta(ctx.agentId);
  const changedContractPaths = delta.contractsChanged.map((c) => c.contract.path);
  const overlappingPaths = delta.overlappingClaims.flatMap((s) => s.claims);
  writeProjectConfig(cwd, {
    ...ctx.config,
    lastKnownChangedContractPaths: changedContractPaths,
    lastKnownOverlappingClaimPaths: overlappingPaths,
  });
  return delta;
}

export async function handleSessionStart(input: HookInput): Promise<string> {
  const ctx = await ensureAgent(input.cwd, input.harness);
  if (!ctx) return "";

  const [{ agents }, { contracts }, { questions }, { findings }] = await Promise.all([
    ctx.client.listAgents(),
    ctx.client.listContracts(),
    ctx.client.listQuestions(),
    ctx.client.listFindings(),
  ]);

  await fetchAndCacheDelta(ctx, input.cwd);

  const others = agents.filter((a) => a.id !== ctx.agentId);
  const openQuestions = questions.filter(
    (q) => q.status === "open" && (q.toAgentId === null || q.toAgentId === ctx.agentId)
  );
  const recentFindings = [...findings].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const brief = renderBrief({ agents: others, contracts, openQuestions, recentFindings });
  return TEAMMATE_LABEL + brief;
}

export async function handleUserPromptSubmit(input: HookInput): Promise<string> {
  const ctx = await ensureAgent(input.cwd, input.harness);
  if (!ctx) return "";

  const delta = await fetchAndCacheDelta(ctx, input.cwd);
  if (deltaIsEmpty(delta)) return "";

  const lines = renderDeltaLines(delta);

  return TEAMMATE_LABEL + lines.join("\n");
}

export async function handlePreToolUse(input: HookInput): Promise<string> {
  if (!input.filePath) return "";
  const config = readProjectConfig(input.cwd);
  if (!config) return "";

  const lines: string[] = [];

  if (isContractPath(input.filePath) && config.lastKnownChangedContractPaths?.includes(input.filePath)) {
    lines.push(`Contract ${input.filePath} changed recently. Read it before writing.`);
  }

  const overlapping = config.lastKnownOverlappingClaimPaths ?? [];
  if (overlapping.some((p) => claimsOverlap(p, input.filePath!))) {
    lines.push(`Heads up: another agent's claims overlap ${input.filePath}. Coordinate before writing.`);
  }

  if (lines.length === 0) return "";
  return TEAMMATE_LABEL + lines.join("\n");
}

export async function handlePostToolUse(input: HookInput): Promise<string> {
  if (!input.filePath) return "";
  const config = readProjectConfig(input.cwd);
  const ctx = await ensureAgent(input.cwd, input.harness);
  if (!ctx || !config) return "";

  const claims = Array.from(new Set([...(config.claims ?? []), input.filePath]));
  writeProjectConfig(input.cwd, { ...ctx.config, claims });

  if (isContractPath(input.filePath)) {
    const fullPath = `${input.cwd}/${input.filePath}`;
    const content = readFileSync(fullPath, "utf8");
    const userName = process.env.KINGPOST_AGENT ?? process.env.USER ?? "unknown";
    await ctx.client.publishContract({ path: input.filePath, content, updatedBy: userName });
  }

  return "";
}
