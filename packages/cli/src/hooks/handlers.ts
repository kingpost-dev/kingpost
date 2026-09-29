import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { readProjectConfig, writeProjectConfig, getToken, type ProjectConfig } from "../config.js";
import { ApiClient } from "../api.js";
import { renderBrief, deltaIsEmpty, claimsOverlap, type Harness, type Delta } from "@kingpost/protocol";
import type { HookInput } from "./parse.js";
import { TEAMMATE_LABEL, renderDeltaLines } from "../delta-format.js";
import { detectFormat } from "../differs/detect-format.js";
import { diffJsonSchema } from "../differs/json-schema.js";
import { diffOpenApi } from "../differs/openapi.js";

function isContractPath(path: string | undefined): boolean {
  return !!path && path.startsWith("contracts/");
}

// hook.ts's shared HANDLER_TIMEOUT_MS budget (3000ms) now has to cover up to 3 sequential
// network calls for a contract path (listContracts, getContract, publishContract). This caps
// the lookup+diff step well below that so publishContract always gets a fair remaining share
// of the window, rather than risking getting killed by hook.ts's unconditional process.exit(0).
const LOOKUP_TIMEOUT_MS = 1000;

/** Looks up the previous version of a contract and diffs it against the new content, treating
 * a slow lookup, a missing previous version, or any lookup failure alike as "not breaking" —
 * never let this block or fail the publish that follows. */
async function detectBreakingChange(
  client: ApiClient,
  path: string,
  format: "json-schema" | "openapi" | "drizzle" | "unknown",
  newContent: string
): Promise<{ breaking: boolean; diffSummary?: string }> {
  if (format !== "json-schema" && format !== "openapi") return { breaking: false };

  try {
    const lookup = (async (): Promise<string | null> => {
      const { contracts } = await client.listContracts();
      const existing = contracts.find((c) => c.path === path);
      if (!existing) return null;
      const { versions } = await client.getContract(existing.id);
      return versions[0]?.content ?? null;
    })();
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS));
    const previousContent = await Promise.race([lookup, timeout]);
    if (!previousContent) return { breaking: false };

    const result = format === "json-schema" ? diffJsonSchema(previousContent, newContent) : await diffOpenApi(previousContent, newContent);
    return { breaking: result.breaking, diffSummary: result.summary };
  } catch {
    return { breaking: false };
  }
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
    const fullPath = join(input.cwd, input.filePath);
    const content = readFileSync(fullPath, "utf8");
    const userName = process.env.KINGPOST_AGENT ?? process.env.USER ?? "unknown";
    const format = detectFormat(input.filePath, content);
    const { breaking, diffSummary } = await detectBreakingChange(ctx.client, input.filePath, format, content);
    await ctx.client.publishContract({ path: input.filePath, content, updatedBy: userName, format, breaking, diffSummary });
  }

  return "";
}
