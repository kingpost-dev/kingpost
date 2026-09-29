import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProjectConfig, writeCredential } from "../config.js";
import { buildMcpServer } from "./server.js";
import * as apiModule from "../api.js";
import * as scanRepoModule from "../scan/scan-repo.js";

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
      delta: { contractsChanged: [], questionsForMe: [], answersToMe: [], findings: [], overlappingClaims: [] },
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
      delta: { contractsChanged: [], questionsForMe: [], answersToMe: [], findings: [], overlappingClaims: [] },
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
      delta: { contractsChanged: [], questionsForMe: [], answersToMe: [], findings: [], overlappingClaims: [] },
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
      delta: { contractsChanged: [], questionsForMe: [], answersToMe: [], findings: [], overlappingClaims: [] },
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
      delta: { contractsChanged: [], questionsForMe: [], answersToMe: [], findings: [], overlappingClaims: [] },
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
      delta: { contractsChanged: [], questionsForMe: [], answersToMe: [], findings: [], overlappingClaims: [] },
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
