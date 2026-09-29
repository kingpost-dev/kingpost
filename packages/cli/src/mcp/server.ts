import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readProjectConfig, writeProjectConfig, getToken } from "../config.js";
import { ApiClient } from "../api.js";
import { renderBrief } from "@kingpost/protocol";
import { TEAMMATE_LABEL, renderDeltaLines } from "../delta-format.js";

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

  server.tool("kingpost_who", "List teammates' agents and what they're doing.", {}, async () => {
    try {
      const { client, agentId } = ctx();
      const { agents } = await client.listAgents();
      const others = agents.filter((a) => a.id !== agentId);
      const text = others.length === 0
        ? "No other agents active."
        : others.map((a) => `${a.userName} [${a.harness}] (id: ${a.id}): ${a.statusText || "idle"} (claims: ${a.claims.join(", ") || "none"})`).join("\n");
      const suffix = await renderDeltaSuffix(client, agentId);
      return { content: [{ type: "text" as const, text: text + suffix }] };
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  });

  server.tool(
    "kingpost_ask",
    "Ask a question to a specific agent (by id, from kingpost_who) or the whole team (omit 'to').",
    { question: z.string(), to: z.string().optional() },
    async ({ question, to }) => {
      try {
        const { client, agentId } = ctx();
        const { question: created } = await client.askQuestion({ fromAgentId: agentId, toAgentId: to ?? null, text: question });
        const suffix = await renderDeltaSuffix(client, agentId);
        return { content: [{ type: "text" as const, text: `Question posted: [${created.id}]${suffix}` }] };
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
