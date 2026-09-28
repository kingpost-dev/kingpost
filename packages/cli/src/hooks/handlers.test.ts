import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProjectConfig, writeCredential, readProjectConfig } from "../config.js";
import { handleSessionStart, handlePreToolUse, handlePostToolUse } from "./handlers.js";
import * as apiModule from "../api.js";

describe("handleSessionStart", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kp-hook-"));
    writeProjectConfig(cwd, { serverUrl: "https://example.invalid", projectId: "proj_1" });
    writeCredential("proj_1", "tok_1");

    vi.spyOn(apiModule.ApiClient.prototype, "registerAgent").mockResolvedValue({ agent: { id: "agent_1" } } as any);
    vi.spyOn(apiModule.ApiClient.prototype, "listAgents").mockResolvedValue({
      agents: [{ id: "agent_2", userName: "sam", harness: "codex", claims: ["ui/*"], statusText: "styling", lastSeen: "", cursor: 0, projectId: "proj_1", cwd: "/x" }],
    } as any);
    vi.spyOn(apiModule.ApiClient.prototype, "listContracts").mockResolvedValue({ contracts: [] });
    vi.spyOn(apiModule.ApiClient.prototype, "listQuestions").mockResolvedValue({ questions: [] });
    vi.spyOn(apiModule.ApiClient.prototype, "listFindings").mockResolvedValue({ findings: [] });
    vi.spyOn(apiModule.ApiClient.prototype, "getDelta").mockResolvedValue({
      delta: { contractsChanged: [], questionsForMe: [], answersToMe: [], findings: [], overlappingClaims: [] },
      cursor: 0,
    });
  });

  it("registers the agent once and returns a labeled brief mentioning the teammate", async () => {
    const out = await handleSessionStart({ harness: "claude", hookEventName: "SessionStart", cwd });
    expect(out).toContain("From teammates' agents");
    expect(out).toContain("sam");
  });
});

describe("handlePreToolUse", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "kp-hook-pre-"));
  });

  it("warns using only cached data, making zero network calls", async () => {
    writeProjectConfig(cwd, {
      serverUrl: "https://example.invalid",
      projectId: "proj_1",
      agentId: "agent_1",
      lastKnownChangedContractPaths: ["contracts/api.ts"],
      lastKnownOverlappingClaimPaths: ["server/auth/*"],
    } as any);
    writeCredential("proj_1", "tok_1");

    const getDeltaSpy = vi.spyOn(apiModule.ApiClient.prototype, "getDelta");

    const out = await handlePreToolUse({ harness: "claude", hookEventName: "PreToolUse", cwd, filePath: "contracts/api.ts" });
    expect(out).toContain("changed recently");
    expect(getDeltaSpy).not.toHaveBeenCalled();

    const out2 = await handlePreToolUse({ harness: "claude", hookEventName: "PreToolUse", cwd, filePath: "server/auth/login.ts" });
    expect(out2).toContain("overlap");
    expect(getDeltaSpy).not.toHaveBeenCalled();
  });

  it("returns empty string when nothing is cached", async () => {
    writeProjectConfig(cwd, { serverUrl: "https://example.invalid", projectId: "proj_1", agentId: "agent_1" });
    writeCredential("proj_1", "tok_1");
    const out = await handlePreToolUse({ harness: "claude", hookEventName: "PreToolUse", cwd, filePath: "server/unrelated.ts" });
    expect(out).toBe("");
  });
});

describe("handlePostToolUse", () => {
  it("records a claim locally without calling publishContract for a non-contract path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kp-hook-post-"));
    writeProjectConfig(cwd, { serverUrl: "https://example.invalid", projectId: "proj_1", agentId: "agent_1" });
    writeCredential("proj_1", "tok_1");
    const publishSpy = vi.spyOn(apiModule.ApiClient.prototype, "publishContract");

    await handlePostToolUse({ harness: "claude", hookEventName: "PostToolUse", cwd, filePath: "ui/App.vue" });

    expect(publishSpy).not.toHaveBeenCalled();
    const config = readProjectConfig(cwd);
    expect(config?.claims).toContain("ui/App.vue");
  });
});

describe("handlePostToolUse — contract path", () => {
  it("publishes the file's content when the path is under contracts/", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kp-hook-post-contract-"));
    mkdirSync(join(cwd, "contracts"), { recursive: true });
    writeFileSync(join(cwd, "contracts/api.ts"), "export type X = 1;");
    writeProjectConfig(cwd, { serverUrl: "https://example.invalid", projectId: "proj_1", agentId: "agent_1" });
    writeCredential("proj_1", "tok_1");
    const publishSpy = vi.spyOn(apiModule.ApiClient.prototype, "publishContract").mockResolvedValue({ contract: {} as any, changed: true });

    await handlePostToolUse({ harness: "claude", hookEventName: "PostToolUse", cwd, filePath: "contracts/api.ts" });

    expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({ path: "contracts/api.ts", content: "export type X = 1;" }));
  });

  // Regression guard for the `${cwd}/${filePath}` manual-concatenation bug: a nested,
  // multi-segment contract path only resolves correctly if the file path is built with
  // node:path's `join` (platform-aware) rather than naive string templating.
  it("publishes the file's content for a nested contract path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kp-hook-post-contract-nested-"));
    mkdirSync(join(cwd, "contracts", "v1"), { recursive: true });
    writeFileSync(join(cwd, "contracts", "v1", "api.ts"), "export type Y = 2;");
    writeProjectConfig(cwd, { serverUrl: "https://example.invalid", projectId: "proj_1", agentId: "agent_1" });
    writeCredential("proj_1", "tok_1");
    const publishSpy = vi.spyOn(apiModule.ApiClient.prototype, "publishContract").mockResolvedValue({ contract: {} as any, changed: true });

    await handlePostToolUse({ harness: "claude", hookEventName: "PostToolUse", cwd, filePath: "contracts/v1/api.ts" });

    expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({ path: "contracts/v1/api.ts", content: "export type Y = 2;" }));
  });
});
