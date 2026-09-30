import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readProjectConfig, writeProjectConfig, getToken } from "../config.js";
import { ApiClient } from "../api.js";
import { renderBrief } from "@kingpost/protocol";
import { TEAMMATE_LABEL, renderDeltaLines } from "../delta-format.js";
import { scanRepo } from "../scan/scan-repo.js";
import { formatAgentLine, routeQuestionTarget } from "../ownership.js";

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `kingpost error: ${message}` }], isError: true };
}

async function renderDeltaSuffix(client: ApiClient, agentId: string): Promise<string> {
  const { delta } = await client.getDelta(agentId);
  const lines = renderDeltaLines(delta);
  if (lines.length === 0) return "";
  return "\n\n" + TEAMMATE_LABEL + lines.join("\n");
}

export function buildMcpServer(cwd: string) {
  const server = new McpServer({ name: "kingpost", version: "0.1.0" });

  function ctx() {
    const config = readProjectConfig(cwd);
    if (!config?.agentId) throw new Error("no kingpost agent registered — run a session-start hook first, or 'kingpost init'/'join'");
    const token = getToken(config.projectId);
    if (!token) throw new Error("no kingpost credentials — run 'kingpost join <invite-link>'");
    return { client: new ApiClient(config.serverUrl, config.projectId, token), agentId: config.agentId, config };
  }

  server.tool(
    "kingpost_status",
    "Set what you are working on and which file paths you are touching.",
    { text: z.string(), claims: z.array(z.string()).default([]) },
    async ({ text, claims }) => {
      try {
        const { client, agentId, config } = ctx();
        // Network write before local cache write: if the local write fails after this succeeds, the cache self-heals on the next SessionStart/UserPromptSubmit (Task 9) — accepted tradeoff, not worth a transaction.
        await client.updateStatus(agentId, { statusText: text, claims });
        writeProjectConfig(cwd, { ...config, claims });
        const suffix = await renderDeltaSuffix(client, agentId);
        return { content: [{ type: "text" as const, text: `Status updated.${suffix}` }] };
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool("kingpost_who", "List teammates' agents and what they're doing, including which registered contracts each one owns.", {}, async () => {
    try {
      const { client, agentId } = ctx();
      const [{ agents }, { contracts }] = await Promise.all([client.listAgents(), client.listContracts()]);
      const others = agents.filter((a) => a.id !== agentId);
      const text = others.length === 0
        ? "No other agents active."
        : others.map((a) => formatAgentLine(a, contracts)).join("\n");
      const suffix = await renderDeltaSuffix(client, agentId);
      return { content: [{ type: "text" as const, text: text + suffix }] };
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  });

  server.tool(
    "kingpost_ask",
    "Ask a question to a specific agent (by id, from kingpost_who) or the whole team (omit 'to'). If 'to' is omitted and the question mentions a registered contract by path or name, it's routed to that contract's owner instead of broadcasting.",
    { question: z.string(), to: z.string().optional() },
    async ({ question, to }) => {
      try {
        const { client, agentId } = ctx();
        let toAgentId: string | null = to ?? null;
        if (!toAgentId) {
          const [{ agents }, { contracts }] = await Promise.all([client.listAgents(), client.listContracts()]);
          toAgentId = routeQuestionTarget(question, contracts, agents, agentId);
        }
        const { question: created } = await client.askQuestion({ fromAgentId: agentId, toAgentId, text: question });
        const suffix = await renderDeltaSuffix(client, agentId);
        const routedNote = !to && toAgentId ? " (auto-routed to the mentioned contract's owner)" : "";
        return { content: [{ type: "text" as const, text: `Question posted: [${created.id}]${routedNote}${suffix}` }] };
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "kingpost_answer",
    "Answer an open question by its id (from a brief or kingpost_who).",
    { questionId: z.string(), text: z.string() },
    async ({ questionId, text }) => {
      try {
        const { client, agentId } = ctx();
        await client.answerQuestion(questionId, { text, byAgentId: agentId });
        const suffix = await renderDeltaSuffix(client, agentId);
        return { content: [{ type: "text" as const, text: `Answered [${questionId}].${suffix}` }] };
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "kingpost_finding",
    "Publish a finding (a gotcha, decision, or note) for the team.",
    { text: z.string(), paths: z.array(z.string()).default([]) },
    async ({ text, paths }) => {
      try {
        const { client, agentId } = ctx();
        await client.publishFinding({ agentId, text, paths });
        const suffix = await renderDeltaSuffix(client, agentId);
        return { content: [{ type: "text" as const, text: `Finding published.${suffix}` }] };
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool("kingpost_contracts", "List registered contracts with their current owner and version.", {}, async () => {
    try {
      const { client, agentId } = ctx();
      const { contracts } = await client.listContracts();
      const text = contracts.length === 0
        ? "No contracts registered yet."
        : contracts.map((c) => `[${c.id}] ${c.path} v${c.currentVersion} (${c.format}) — owner: ${c.ownerUserName ?? "unowned"}`).join("\n");
      const suffix = await renderDeltaSuffix(client, agentId);
      return { content: [{ type: "text" as const, text: text + suffix }] };
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  });

  server.tool("kingpost_contract", "Get one contract's details and version history by id (from kingpost_contracts).", { id: z.string() }, async ({ id }) => {
    try {
      const { client, agentId } = ctx();
      const { contract, versions } = await client.getContract(id);
      const header = `[${contract.id}] ${contract.path} (${contract.format}) — owner: ${contract.ownerUserName ?? "unowned"}, current v${contract.currentVersion}`;
      const history = versions.map((v) => `- v${v.version} by ${v.updatedBy} at ${v.createdAt}${v.breaking ? ` ⚠ BREAKING: ${v.diffSummary}` : ""}`).join("\n");
      const suffix = await renderDeltaSuffix(client, agentId);
      return { content: [{ type: "text" as const, text: `${header}\n${history}${suffix}` }] };
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  });

  server.tool(
    "kingpost_consume",
    "Declare that a file you're working on depends on (consumes) a registered contract, by the contract's id.",
    { contractId: z.string(), path: z.string() },
    async ({ contractId, path }) => {
      try {
        const { client, agentId } = ctx();
        await client.declareConsumer(contractId, { path, agentId });
        const suffix = await renderDeltaSuffix(client, agentId);
        return { content: [{ type: "text" as const, text: `Registered ${path} as a consumer of [${contractId}].${suffix}` }] };
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "kingpost_scan",
    "Re-scan the whole repo's relative imports and record every file that consumes a registered contract. Runs automatically on init/join and on every file write; use this to force a full re-scan.",
    {},
    async () => {
      try {
        const { client, agentId } = ctx();
        const count = await scanRepo(cwd, client, agentId);
        const suffix = await renderDeltaSuffix(client, agentId);
        return { content: [{ type: "text" as const, text: `Scan complete: ${count} contract consumer relationship(s) recorded.${suffix}` }] };
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "kingpost_transfer",
    "Transfer ownership of a contract to a different user (by their name, from kingpost_who).",
    { contractId: z.string(), toUserName: z.string() },
    async ({ contractId, toUserName }) => {
      try {
        const { client, agentId } = ctx();
        await client.transferContract(contractId, toUserName);
        const suffix = await renderDeltaSuffix(client, agentId);
        return { content: [{ type: "text" as const, text: `Ownership of [${contractId}] transferred to ${toUserName}.${suffix}` }] };
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "kingpost_propose",
    "Propose a change to a contract — creates a proposal (notifying the owner and its consumers), without blocking you from continuing other work. Use this instead of editing contracts/** directly when your change would be breaking, or when you don't own the contract.",
    { contractId: z.string(), newContent: z.string(), rationale: z.string() },
    async ({ contractId, newContent, rationale }) => {
      try {
        const { client, agentId } = ctx();
        const { proposal } = await client.proposeChange(contractId, { proposedByAgentId: agentId, newContent, rationale });
        const suffix = await renderDeltaSuffix(client, agentId);
        return { content: [{ type: "text" as const, text: `Proposal [${proposal.id}] created for [${contractId}].${suffix}` }] };
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "kingpost_accept",
    "Accept a proposal (by id, from a brief or delta) as the contract's owner — publishes the proposed content as a new version and notifies consumers.",
    { proposalId: z.string() },
    async ({ proposalId }) => {
      try {
        const { client, agentId } = ctx();
        const { contract, version } = await client.acceptProposal(proposalId);
        const suffix = await renderDeltaSuffix(client, agentId);
        return { content: [{ type: "text" as const, text: `Proposal [${proposalId}] accepted. ${contract.path} is now v${version.version}.${suffix}` }] };
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool("kingpost_brief", "Get the same brief you got at session start.", {}, async () => {
    try {
      const { client, agentId } = ctx();
      const [{ agents }, { contracts }, { questions }, { findings }] = await Promise.all([
        client.listAgents(),
        client.listContracts(),
        client.listQuestions(),
        client.listFindings(),
      ]);
      const others = agents.filter((a) => a.id !== agentId);
      const openQuestions = questions.filter((q) => q.status === "open" && (q.toAgentId === null || q.toAgentId === agentId));
      const recentFindings = [...findings].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const text = renderBrief({ agents: others, contracts, openQuestions, recentFindings });
      const suffix = await renderDeltaSuffix(client, agentId);
      return { content: [{ type: "text" as const, text: text + suffix }] };
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  });

  return server;
}

export async function runMcpServer(cwd: string): Promise<void> {
  const server = buildMcpServer(cwd);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
