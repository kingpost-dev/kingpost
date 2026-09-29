import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProjectConfig, writeCredential } from "../config.js";
import { buildMcpServer } from "./server.js";
import * as apiModule from "../api.js";

describe("kingpost_who", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kp-mcp-"));
    writeProjectConfig(cwd, { serverUrl: "https://example.invalid", projectId: "proj_1", agentId: "agent_1" });
    writeCredential("proj_1", "tok_1");
    vi.spyOn(apiModule.ApiClient.prototype, "listAgents").mockResolvedValue({
      agents: [{ id: "agent_2", userName: "sam", harness: "codex", claims: ["ui/*"], statusText: "styling", lastSeen: "", cursor: 0, projectId: "proj_1", cwd: "/x" }],
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
