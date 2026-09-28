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
