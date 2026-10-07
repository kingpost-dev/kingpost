import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProjectConfig, writeCredential } from "../config.js";
import { buildMcpServer } from "./server.js";
import * as apiModule from "../api.js";
import * as scanRepoModule from "../scan/scan-repo.js";
import { emptyDelta } from "../test-helpers/empty-delta.js";

describe("kingpost_who", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kp-mcp-"));
    writeProjectConfig(cwd, { serverUrl: "https://example.invalid", projectId: "proj_1", agentId: "agent_1" });
    writeCredential("proj_1", "tok_1");
    vi.spyOn(apiModule.ApiClient.prototype, "listAgents").mockResolvedValue({
      agents: [{ id: "agent_2", userName: "sam", harness: "codex", claims: ["ui/*"], statusText: "styling", lastSeen: "", cursor: 0, projectId: "proj_1", cwd: "/x" }],
    } as any);
    vi.spyOn(apiModule.ApiClient.prototype, "listContracts").mockResolvedValue({
      contracts: [{ id: "c1", path: "contracts/api.ts", format: "typescript", currentVersion: 1, ownerAgentId: "agent_2", ownerUserName: "sam", createdAt: "" }],
    } as any);
    vi.spyOn(apiModule.ApiClient.prototype, "getDelta").mockResolvedValue({
      delta: emptyDelta(),
      cursor: 0,
    });
  });

  it("lists other agents without throwing", async () => {
    const server = buildMcpServer(cwd);
    // The installed @modelcontextprotocol/sdk (1.30.1) stores a registered tool's callback under
    // `handler` (not `callback`) on the object in `_registeredTools` — confirmed by reading
    // node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js `_createRegisteredTool`.
    // NOTE: relies on @modelcontextprotocol/sdk@1.30.1 internals (._registeredTools[name].handler); may need updating on SDK upgrade — inspect the real object if this breaks.
    const tool = (server as any)._registeredTools?.["kingpost_who"];
    if (!tool) throw new Error("Could not find kingpost_who's registered callback on the McpServer instance — inspect the actual SDK's internals and adjust this test.");
    const result = await tool.handler({}, {});
    expect(result.content[0].text).toContain("sam");
    expect(result.content[0].text).toContain("agent_2");
  });

  it("lists which contracts each agent owns", async () => {
    const server = buildMcpServer(cwd);
    const tool = (server as any)._registeredTools?.["kingpost_who"];
    if (!tool) throw new Error("Could not find kingpost_who's registered callback on the McpServer instance.");
    const result = await tool.handler({}, {});
    expect(result.content[0].text).toContain("(owns: contracts/api.ts)");
  });

  it("returns a readable error instead of throwing when unregistered", async () => {
    const emptyCwd = mkdtempSync(join(tmpdir(), "kp-mcp-empty-"));
    const server = buildMcpServer(emptyCwd);
    // NOTE: relies on @modelcontextprotocol/sdk@1.30.1 internals (._registeredTools[name].handler); may need updating on SDK upgrade — inspect the real object if this breaks.
    const tool = (server as any)._registeredTools?.["kingpost_who"];
    const result = await tool.handler({}, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("kingpost error");
  });
});

describe("kingpost_contracts", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kp-mcp-"));
    writeProjectConfig(cwd, { serverUrl: "https://example.invalid", projectId: "proj_1", agentId: "agent_1" });
    writeCredential("proj_1", "tok_1");
    vi.spyOn(apiModule.ApiClient.prototype, "listContracts").mockResolvedValue({
      contracts: [
        { id: "c1", path: "contracts/api.ts", format: "typescript", currentVersion: 3, ownerAgentId: "agent_2", ownerUserName: "sam", createdAt: "" },
      ],
    } as any);
    vi.spyOn(apiModule.ApiClient.prototype, "getDelta").mockResolvedValue({
      delta: emptyDelta(),
      cursor: 0,
    });
  });

  it("lists contracts with path, version, and owner", async () => {
    const server = buildMcpServer(cwd);
    const tool = (server as any)._registeredTools?.["kingpost_contracts"];
    if (!tool) throw new Error("Could not find kingpost_contracts's registered callback on the McpServer instance.");
    const result = await tool.handler({}, {});
    expect(result.content[0].text).toContain("contracts/api.ts");
    expect(result.content[0].text).toContain("v3");
    expect(result.content[0].text).toContain("sam");
  });
});

describe("kingpost_contract", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kp-mcp-"));
    writeProjectConfig(cwd, { serverUrl: "https://example.invalid", projectId: "proj_1", agentId: "agent_1" });
    writeCredential("proj_1", "tok_1");
    vi.spyOn(apiModule.ApiClient.prototype, "getContract").mockResolvedValue({
      contract: { id: "c1", path: "contracts/api.json", format: "json-schema", currentVersion: 2, ownerAgentId: "agent_2", ownerUserName: "sam", createdAt: "" },
      versions: [
        { id: "v2", contractId: "c1", version: 2, contentSha256: "", content: null, updatedBy: "sam", breaking: true, diffSummary: "removed field X", createdAt: "" },
        { id: "v1", contractId: "c1", version: 1, contentSha256: "", content: null, updatedBy: "sam", breaking: false, diffSummary: null, createdAt: "" },
      ],
    } as any);
    vi.spyOn(apiModule.ApiClient.prototype, "getDelta").mockResolvedValue({
      delta: emptyDelta(),
      cursor: 0,
    });
  });

  it("marks breaking versions and leaves non-breaking versions unmarked", async () => {
    const server = buildMcpServer(cwd);
    const tool = (server as any)._registeredTools?.["kingpost_contract"];
    if (!tool) throw new Error("Could not find kingpost_contract's registered callback on the McpServer instance.");
    const result = await tool.handler({ id: "c1" }, {});
    const text = result.content[0].text as string;
    expect(text).toContain("⚠ BREAKING: removed field X");
    const nonBreakingLine = text.split("\n").find((line: string) => line.startsWith("- v1"));
    expect(nonBreakingLine).toBeDefined();
    expect(nonBreakingLine).not.toContain("⚠ BREAKING");
  });
});

describe("kingpost_consume", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kp-mcp-"));
    writeProjectConfig(cwd, { serverUrl: "https://example.invalid", projectId: "proj_1", agentId: "agent_1" });
    writeCredential("proj_1", "tok_1");
    vi.spyOn(apiModule.ApiClient.prototype, "getDelta").mockResolvedValue({
      delta: emptyDelta(),
      cursor: 0,
    });
  });

  it("declares a consumer with the contract id, path, and calling agent id", async () => {
    const declareSpy = vi.spyOn(apiModule.ApiClient.prototype, "declareConsumer").mockResolvedValue({ consumer: {} as any });
    const server = buildMcpServer(cwd);
    const tool = (server as any)._registeredTools?.["kingpost_consume"];
    if (!tool) throw new Error("Could not find kingpost_consume's registered callback on the McpServer instance.");
    const result = await tool.handler({ contractId: "c1", path: "ui/App.tsx" }, {});
    expect(declareSpy).toHaveBeenCalledWith("c1", { path: "ui/App.tsx", agentId: "agent_1" });
    expect(result.content[0].text).toContain("ui/App.tsx");
    expect(result.content[0].text).toContain("c1");
  });
});

describe("kingpost_ask", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kp-mcp-"));
    writeProjectConfig(cwd, { serverUrl: "https://example.invalid", projectId: "proj_1", agentId: "agent_asker" });
    writeCredential("proj_1", "tok_1");
    vi.spyOn(apiModule.ApiClient.prototype, "getDelta").mockResolvedValue({
      delta: emptyDelta(),
      cursor: 0,
    });
  });

  it("routes to the mentioned contract's owner when 'to' is omitted", async () => {
    vi.spyOn(apiModule.ApiClient.prototype, "listContracts").mockResolvedValue({
      contracts: [{ id: "c1", path: "contracts/api.ts", format: "typescript", currentVersion: 1, ownerAgentId: "agent_owner", ownerUserName: "alex", createdAt: "" }],
    } as any);
    vi.spyOn(apiModule.ApiClient.prototype, "listAgents").mockResolvedValue({
      agents: [{ id: "agent_owner", userName: "alex", harness: "claude", claims: [], statusText: "", lastSeen: "", cursor: 0, projectId: "proj_1", cwd: "/x" }],
    } as any);
    const askSpy = vi.spyOn(apiModule.ApiClient.prototype, "askQuestion").mockResolvedValue({ question: { id: "q1" } as any });
    const server = buildMcpServer(cwd);
    const tool = (server as any)._registeredTools?.["kingpost_ask"];
    if (!tool) throw new Error("Could not find kingpost_ask's registered callback on the McpServer instance.");
    const result = await tool.handler({ question: "does contracts/api.ts support pagination?" }, {});
    expect(askSpy).toHaveBeenCalledWith({ fromAgentId: "agent_asker", toAgentId: "agent_owner", text: "does contracts/api.ts support pagination?" });
    expect(result.content[0].text).toContain("auto-routed");
  });

  it("broadcasts (toAgentId: null) when 'to' is omitted and no contract is mentioned", async () => {
    vi.spyOn(apiModule.ApiClient.prototype, "listContracts").mockResolvedValue({ contracts: [] } as any);
    vi.spyOn(apiModule.ApiClient.prototype, "listAgents").mockResolvedValue({ agents: [] } as any);
    const askSpy = vi.spyOn(apiModule.ApiClient.prototype, "askQuestion").mockResolvedValue({ question: { id: "q2" } as any });
    const server = buildMcpServer(cwd);
    const tool = (server as any)._registeredTools?.["kingpost_ask"];
    if (!tool) throw new Error("Could not find kingpost_ask's registered callback on the McpServer instance.");
    const result = await tool.handler({ question: "how's it going?" }, {});
    expect(askSpy).toHaveBeenCalledWith({ fromAgentId: "agent_asker", toAgentId: null, text: "how's it going?" });
    expect(result.content[0].text).not.toContain("auto-routed");
  });

  it("bypasses routing entirely when 'to' is explicitly passed", async () => {
    const contractsSpy = vi.spyOn(apiModule.ApiClient.prototype, "listContracts");
    const agentsSpy = vi.spyOn(apiModule.ApiClient.prototype, "listAgents");
    const askSpy = vi.spyOn(apiModule.ApiClient.prototype, "askQuestion").mockResolvedValue({ question: { id: "q3" } as any });
    const server = buildMcpServer(cwd);
    const tool = (server as any)._registeredTools?.["kingpost_ask"];
    if (!tool) throw new Error("Could not find kingpost_ask's registered callback on the McpServer instance.");
    const result = await tool.handler({ question: "does contracts/api.ts support pagination?", to: "agent_owner" }, {});
    expect(contractsSpy).not.toHaveBeenCalled();
    expect(agentsSpy).not.toHaveBeenCalled();
    expect(askSpy).toHaveBeenCalledWith({ fromAgentId: "agent_asker", toAgentId: "agent_owner", text: "does contracts/api.ts support pagination?" });
    expect(result.content[0].text).not.toContain("auto-routed");
  });
});

vi.mock("../scan/scan-repo.js", () => ({ scanRepo: vi.fn() }));

describe("kingpost_scan", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kp-mcp-"));
    writeProjectConfig(cwd, { serverUrl: "https://example.invalid", projectId: "proj_1", agentId: "agent_1" });
    writeCredential("proj_1", "tok_1");
    vi.spyOn(apiModule.ApiClient.prototype, "getDelta").mockResolvedValue({
      delta: emptyDelta(),
      cursor: 0,
    });
  });

  it("scans the current project with the registered agent id and reports the count", async () => {
    vi.mocked(scanRepoModule.scanRepo).mockResolvedValue(3);
    const server = buildMcpServer(cwd);
    const tool = (server as any)._registeredTools?.["kingpost_scan"];
    if (!tool) throw new Error("Could not find kingpost_scan's registered callback on the McpServer instance.");
    const result = await tool.handler({}, {});
    expect(scanRepoModule.scanRepo).toHaveBeenCalledWith(cwd, expect.any(apiModule.ApiClient), "agent_1");
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("3");
  });

  it("returns a readable error when unregistered", async () => {
    const emptyCwd = mkdtempSync(join(tmpdir(), "kp-mcp-empty-"));
    const server = buildMcpServer(emptyCwd);
    const tool = (server as any)._registeredTools?.["kingpost_scan"];
    const result = await tool.handler({}, {});
    expect(result.isError).toBe(true);
  });
});

describe("kingpost_propose", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kp-mcp-"));
    writeProjectConfig(cwd, { serverUrl: "https://example.invalid", projectId: "proj_1", agentId: "agent_1" });
    writeCredential("proj_1", "tok_1");
    vi.spyOn(apiModule.ApiClient.prototype, "getDelta").mockResolvedValue({
      delta: emptyDelta(),
      cursor: 0,
    });
  });

  it("proposes a change using the calling agent's own id, and reports the new proposal's id", async () => {
    const proposeSpy = vi.spyOn(apiModule.ApiClient.prototype, "proposeChange").mockResolvedValue({ proposal: { id: "proposal_1" } as any });
    const server = buildMcpServer(cwd);
    const tool = (server as any)._registeredTools?.["kingpost_propose"];
    if (!tool) throw new Error("Could not find kingpost_propose's registered callback on the McpServer instance.");
    const result = await tool.handler({ contractId: "c1", newContent: "{}", rationale: "tighten validation" }, {});
    expect(proposeSpy).toHaveBeenCalledWith("c1", { proposedByAgentId: "agent_1", newContent: "{}", rationale: "tighten validation" });
    expect(result.content[0].text).toContain("proposal_1");
  });

  it("returns a readable error instead of throwing when the client call rejects", async () => {
    vi.spyOn(apiModule.ApiClient.prototype, "proposeChange").mockRejectedValue(new Error("kingpost server returned 500"));
    const server = buildMcpServer(cwd);
    const tool = (server as any)._registeredTools?.["kingpost_propose"];
    const result = await tool.handler({ contractId: "c1", newContent: "{}", rationale: "tighten validation" }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("kingpost error");
  });
});

describe("kingpost_accept", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kp-mcp-"));
    writeProjectConfig(cwd, { serverUrl: "https://example.invalid", projectId: "proj_1", agentId: "agent_1" });
    writeCredential("proj_1", "tok_1");
    vi.spyOn(apiModule.ApiClient.prototype, "getDelta").mockResolvedValue({
      delta: emptyDelta(),
      cursor: 0,
    });
  });

  it("accepts a proposal by id, and reports the resulting contract path and version", async () => {
    const acceptSpy = vi.spyOn(apiModule.ApiClient.prototype, "acceptProposal").mockResolvedValue({
      proposal: { id: "proposal_1" } as any,
      contract: { id: "c1", path: "contracts/api.json" } as any,
      version: { version: 3 } as any,
    });
    const server = buildMcpServer(cwd);
    const tool = (server as any)._registeredTools?.["kingpost_accept"];
    if (!tool) throw new Error("Could not find kingpost_accept's registered callback on the McpServer instance.");
    const result = await tool.handler({ proposalId: "proposal_1" }, {});
    expect(acceptSpy).toHaveBeenCalledWith("proposal_1", "agent_1"); // names the acting agent so the server can check ownership
    expect(result.content[0].text).toContain("contracts/api.json");
    expect(result.content[0].text).toContain("v3");
  });

  it("returns a readable error instead of throwing when the client call rejects", async () => {
    vi.spyOn(apiModule.ApiClient.prototype, "acceptProposal").mockRejectedValue(new Error("kingpost server returned 500"));
    const server = buildMcpServer(cwd);
    const tool = (server as any)._registeredTools?.["kingpost_accept"];
    const result = await tool.handler({ proposalId: "proposal_1" }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("kingpost error");
  });
});

describe("kingpost_reject, kingpost_reply and kingpost_proposal", () => {
  let cwd: string;
  const toolFor = (name: string) => {
    const tool = (buildMcpServer(cwd) as any)._registeredTools?.[name];
    if (!tool) throw new Error(`Could not find ${name}'s registered callback on the McpServer instance.`);
    return tool;
  };

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kp-mcp-"));
    writeProjectConfig(cwd, { serverUrl: "https://example.invalid", projectId: "proj_1", agentId: "agent_1" });
    writeCredential("proj_1", "tok_1");
    vi.spyOn(apiModule.ApiClient.prototype, "getDelta").mockResolvedValue({ delta: emptyDelta(), cursor: 0 });
  });

  it("rejects a proposal as the calling agent, with the reason", async () => {
    const spy = vi.spyOn(apiModule.ApiClient.prototype, "rejectProposal").mockResolvedValue({ proposal: { id: "proposal_1" } as any });
    const result = await toolFor("kingpost_reject").handler({ proposalId: "proposal_1", reason: "breaks billing" }, {});
    expect(spy).toHaveBeenCalledWith("proposal_1", { byAgentId: "agent_1", reason: "breaks billing" });
    expect(result.content[0].text).toContain("Rejected [proposal_1]");
  });

  it("replies to a proposal as the calling agent", async () => {
    const spy = vi.spyOn(apiModule.ApiClient.prototype, "replyToProposal").mockResolvedValue({ reply: { id: "reply_1" } as any });
    const result = await toolFor("kingpost_reply").handler({ proposalId: "proposal_1", text: "keep id optional?" }, {});
    expect(spy).toHaveBeenCalledWith("proposal_1", { byAgentId: "agent_1", text: "keep id optional?" });
    expect(result.content[0].text).toContain("Reply posted on [proposal_1]");
  });

  it("shows a proposal with its status, content and reply thread", async () => {
    vi.spyOn(apiModule.ApiClient.prototype, "getProposal").mockResolvedValue({
      proposal: { id: "proposal_1", contractId: "c1", proposedByAgentId: "agent_2", newContent: '{"a":2}', rationale: "widen", status: "rejected", rejectionReason: "breaks billing", createdAt: "" },
      replies: [{ id: "r1", proposalId: "proposal_1", byAgentId: "agent_3", byUserName: "carol", text: "careful", createdAt: "" }],
    } as any);
    const text = (await toolFor("kingpost_proposal").handler({ proposalId: "proposal_1" }, {})).content[0].text;
    expect(text).toContain("rejected");
    expect(text).toContain("breaks billing");
    expect(text).toContain('{"a":2}');
    expect(text).toContain("carol: careful");
  });

  it.each(["kingpost_reject", "kingpost_reply", "kingpost_proposal"])("%s returns a readable error instead of throwing when the server call fails", async (name) => {
    vi.spyOn(apiModule.ApiClient.prototype, "rejectProposal").mockRejectedValue(new Error("kingpost server returned 403"));
    vi.spyOn(apiModule.ApiClient.prototype, "replyToProposal").mockRejectedValue(new Error("kingpost server returned 403"));
    vi.spyOn(apiModule.ApiClient.prototype, "getProposal").mockRejectedValue(new Error("kingpost server returned 404"));
    const result = await toolFor(name).handler({ proposalId: "p", reason: "r", text: "t" }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("kingpost error");
  });
});
