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
import { diffDrizzle } from "../differs/drizzle.js";
import { findConsumedContractIds } from "../scan/match-contracts.js";
import { log } from "./log.js";

export function isContractPath(path: string | undefined): boolean {
  return !!path && path.startsWith("contracts/");
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/** Extracts a source file's relative imports, resolves them against registered contracts, and
 * declares this file as a consumer of any match — a "derived" consumer relationship (nobody
 * explicitly asked for it, it's inferred from the import graph). Never let a network hiccup or a
 * parse failure here block the hook's normal completion, same posture as detectBreakingChange. */
async function scanForConsumedContracts(
  client: ApiClient,
  agentId: string,
  filePath: string,
  content: string
): Promise<void> {
  try {
    const contractIds = await findConsumedContractIds(filePath, content, async () => (await client.listContracts()).contracts);
    await Promise.all(
      contractIds.map((contractId) => client.declareConsumer(contractId, { path: filePath, agentId, declared: false }))
    );
  } catch {
    // Never let a failed scan block the hook — same posture as detectBreakingChange.
  }
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
  newContent: string,
  lookupTimeoutMs: number = LOOKUP_TIMEOUT_MS
): Promise<{ breaking: boolean; diffSummary?: string }> {
  if (format !== "json-schema" && format !== "openapi" && format !== "drizzle") return { breaking: false };

  try {
    const lookup = (async (): Promise<string | null> => {
      const { contracts } = await client.listContracts();
      const existing = contracts.find((c) => c.path === path);
      if (!existing) return null;
      const { versions } = await client.getContract(existing.id);
      return versions[0]?.content ?? null;
    })();
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), lookupTimeoutMs));
    const previousContent = await Promise.race([lookup, timeout]);
    if (!previousContent) {
      log(`breaking-change check for ${path}: no previous version found within ${lookupTimeoutMs}ms (slow lookup, or the contract isn't registered yet), not blocking`);
      return { breaking: false };
    }

    const result =
      format === "json-schema" ? diffJsonSchema(previousContent, newContent) :
      format === "openapi" ? await diffOpenApi(previousContent, newContent) :
      diffDrizzle(previousContent, newContent);
    return { breaking: result.breaking, diffSummary: result.summary };
  } catch (e) {
    log(`breaking-change check for ${path} failed (${e instanceof Error ? e.message : String(e)}), not blocking`);
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

  const delta = await fetchAndCacheDelta(ctx, input.cwd);

  const others = agents.filter((a) => a.id !== ctx.agentId);
  const openQuestions = questions.filter(
    (q) => q.status === "open" && (q.toAgentId === null || q.toAgentId === ctx.agentId)
  );
  const recentFindings = [...findings].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const brief = renderBrief({ agents: others, contracts, openQuestions, recentFindings });

  // Fetching the delta advances this agent's server-side cursor, so whatever it holds is never delivered
  // again. The brief already covers contracts, open questions, findings and teammates, but NOT things
  // addressed to this agent personally (answers to its questions, proposals) that arrived while its
  // session was closed; dropping the delta here silently lost those.
  const missed = deltaIsEmpty(delta)
    ? []
    : renderDeltaLines({ ...delta, contractsChanged: [], questionsForMe: [], findings: [], overlappingClaims: [] });
  const sinceLastSession = missed.length === 0 ? "" : `\n\nSince your last session:\n${missed.join("\n")}`;
  return TEAMMATE_LABEL + brief + sinceLastSession;
}

export async function handleUserPromptSubmit(input: HookInput): Promise<string> {
  const ctx = await ensureAgent(input.cwd, input.harness);
  if (!ctx) return "";

  const delta = await fetchAndCacheDelta(ctx, input.cwd);
  if (deltaIsEmpty(delta)) return "";

  const lines = renderDeltaLines(delta);

  return TEAMMATE_LABEL + lines.join("\n");
}

export type PreToolUseResult =
  | { kind: "none" }
  | { kind: "context"; text: string }
  | { kind: "block"; reason: string };

// The block check only does network work for an edit to a contract file, which is rare, and failing
// open here silently lets a breaking change through. So it gets a far more generous budget than the
// hooks that run on every prompt: a 1s lookup budget was measured expiring on cold CI runners (Windows
// and macOS), and every one of those let a breaking edit to a consumed contract through.
// BLOCK_CHECK_TIMEOUT_MS must stay under hook.ts's PRE_TOOL_USE_TIMEOUT_MS, so a slow check resolves here
// as "don't block" (and logs why) rather than being cut off by hook.ts's own race.
const BLOCK_CHECK_API_TIMEOUT_MS = 5000;
const BLOCK_CHECK_LOOKUP_TIMEOUT_MS = 5000;
const BLOCK_CHECK_TIMEOUT_MS = 8000;

/** Returns a block reason if writing `proposedContent` to this contract would be a breaking change
 * AND the contract has consumers; null otherwise. Any failure, missing credential, or timeout is
 * null — an inability to determine breaking-ness must never block a write (fail open, same
 * posture as detectBreakingChange). */
async function findBreakingChangeBlock(config: ProjectConfig, filePath: string, proposedContent: string): Promise<string | null> {
  const token = getToken(config.projectId);
  if (!token) {
    log(`block check for ${filePath}: no credential for project ${config.projectId}, not blocking`);
    return null;
  }
  const client = new ApiClient(config.serverUrl, config.projectId, token, BLOCK_CHECK_API_TIMEOUT_MS);

  try {
    const check = (async (): Promise<string | null> => {
      const format = detectFormat(filePath, proposedContent);
      const { breaking, diffSummary } = await detectBreakingChange(client, filePath, format, proposedContent, BLOCK_CHECK_LOOKUP_TIMEOUT_MS);
      if (!breaking) return null;

      // A second listContracts() call: detectBreakingChange already looked one up internally
      // to find the previous version, but doesn't return the contract's id, which is needed
      // here for listConsumers. Not worth changing detectBreakingChange's signature to shave
      // this one extra call — it's reused verbatim by the (unrelated) PostToolUse publish path too.
      const { contracts } = await client.listContracts();
      const contract = contracts.find((c) => c.path === filePath);
      if (!contract) {
        log(`block check for ${filePath}: breaking, but the contract isn't in the registry, not blocking`);
        return null;
      }
      const [{ consumers }, { agents }] = await Promise.all([client.listConsumers(contract.id), client.listAgents()]);
      if (consumers.length === 0) {
        log(`block check for ${filePath}: breaking, but no consumers are registered, not blocking`);
        return null;
      }

      // Best-effort owner resolution: a consumer with a null or unknown agentId is simply left out.
      const userNameById = new Map(agents.map((a) => [a.id, a.userName]));
      const owners = Array.from(
        new Set(consumers.flatMap((c) => {
          const userName = c.agentId ? userNameById.get(c.agentId) : undefined;
          return userName ? [userName] : [];
        }))
      );

      // diffSummary comes from the differs, which each produce a plain-language summary.
      return (
        `Breaking change to \`${filePath}\`: ${diffSummary ?? "unspecified change"}. ` +
        `Consumers: ${consumers.map((c) => c.path).join(", ")} (owners: ${owners.length > 0 ? owners.join(", ") : "unknown"}). ` +
        `Options: version it (\`v2\` path), propose via \`kingpost_propose\`, or edit consumers in the same change.`
      );
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        log(`block check for ${filePath}: timed out after ${BLOCK_CHECK_TIMEOUT_MS}ms, not blocking`);
        resolve(null);
      }, BLOCK_CHECK_TIMEOUT_MS);
    });
    try {
      return await Promise.race([check, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    log(`block check for ${filePath} failed (${e instanceof Error ? e.message : String(e)}), not blocking`);
    return null;
  }
}

export async function handlePreToolUse(input: HookInput): Promise<PreToolUseResult> {
  if (!input.filePath) return { kind: "none" };
  const config = readProjectConfig(input.cwd);
  if (!config) return { kind: "none" };

  const lines: string[] = [];

  if (isContractPath(input.filePath) && config.lastKnownChangedContractPaths?.includes(input.filePath)) {
    lines.push(`Contract ${input.filePath} changed recently. Read it before writing.`);
  }

  const overlapping = config.lastKnownOverlappingClaimPaths ?? [];
  if (overlapping.some((p) => claimsOverlap(p, input.filePath!))) {
    lines.push(`Heads up: another agent's claims overlap ${input.filePath}. Coordinate before writing.`);
  }

  if (isContractPath(input.filePath) && input.proposedContent !== undefined) {
    const reason = await findBreakingChangeBlock(config, input.filePath, input.proposedContent);
    if (reason) {
      if (process.env.KINGPOST_FORCE !== "1") {
        // Fold in any advisory lines already queued above (contract-changed, claims-overlap) —
        // a block is emitted as a deny carrying only this reason text (no separate
        // additionalContext alongside it), so losing them here would silently drop real
        // signal, not just cosmetic detail.
        const fullReason = lines.length > 0 ? `${reason}\n\n${lines.join("\n")}` : reason;
        return { kind: "block", reason: fullReason };
      }
      log(`KINGPOST_FORCE=1 override: allowed write to ${input.filePath} that would have been blocked: ${reason}`);
      lines.push(`KINGPOST_FORCE=1 is set, so this write was allowed through instead of blocked. It would have been blocked because: ${reason}`);
    }
  }

  if (lines.length === 0) return { kind: "none" };
  return { kind: "context", text: TEAMMATE_LABEL + lines.join("\n") };
}

export async function handlePostToolUse(input: HookInput): Promise<string> {
  if (!input.filePath) return "";
  const config = readProjectConfig(input.cwd);
  const ctx = await ensureAgent(input.cwd, input.harness);
  if (!ctx || !config) return "";

  const claims = Array.from(new Set([...(config.claims ?? []), input.filePath]));
  writeProjectConfig(input.cwd, { ...ctx.config, claims });

  const isContract = isContractPath(input.filePath);
  const isSourceFile = SOURCE_EXTENSIONS.some((ext) => input.filePath!.endsWith(ext));

  if (isContract || isSourceFile) {
    const fullPath = join(input.cwd, input.filePath);
    const content = readFileSync(fullPath, "utf8");

    if (isContract) {
      const userName = process.env.KINGPOST_AGENT ?? process.env.USER ?? "unknown";
      const format = detectFormat(input.filePath, content);
      const { breaking, diffSummary } = await detectBreakingChange(ctx.client, input.filePath, format, content);
      await ctx.client.publishContract({ path: input.filePath, content, updatedBy: userName, format, breaking, diffSummary });
    } else {
      await scanForConsumedContracts(ctx.client, ctx.agentId, input.filePath, content);
    }
  }

  return "";
}
