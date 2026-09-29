import { describe, it, expect } from "vitest";
import { formatAgentLine } from "./ownership.js";
import type { Agent, Contract } from "@kingpost/protocol";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_1", projectId: "proj_1", userName: "sam", harness: "claude", cwd: "/x",
    statusText: "styling", claims: ["ui/*"], lastSeen: "", cursor: 0, ...overrides,
  };
}

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: "contract_1", path: "contracts/api.ts", format: "json-schema", currentVersion: 1,
    ownerAgentId: null, ownerUserName: null, createdAt: "", ...overrides,
  };
}

describe("formatAgentLine", () => {
  it("renders the base line unchanged when the agent owns nothing", () => {
    expect(formatAgentLine(agent(), [])).toBe(
      "sam [claude] (id: agent_1): styling (claims: ui/*)"
    );
  });

  it("appends one owned contract", () => {
    const contracts = [contract({ path: "contracts/api.ts", ownerUserName: "sam" })];
    expect(formatAgentLine(agent(), contracts)).toBe(
      "sam [claude] (id: agent_1): styling (claims: ui/*) (owns: contracts/api.ts)"
    );
  });

  it("groups multiple owned contracts into one suffix, sorted by path", () => {
    const contracts = [
      contract({ id: "c1", path: "contracts/z.ts", ownerUserName: "sam" }),
      contract({ id: "c2", path: "contracts/a.ts", ownerUserName: "sam" }),
    ];
    expect(formatAgentLine(agent(), contracts)).toBe(
      "sam [claude] (id: agent_1): styling (claims: ui/*) (owns: contracts/a.ts, contracts/z.ts)"
    );
  });

  it("does not include contracts owned by a different user", () => {
    const contracts = [contract({ ownerUserName: "alex" })];
    expect(formatAgentLine(agent(), contracts)).toBe(
      "sam [claude] (id: agent_1): styling (claims: ui/*)"
    );
  });

  it("falls back to 'idle'/'none' exactly like the pre-existing line format", () => {
    expect(formatAgentLine(agent({ statusText: "", claims: [] }), [])).toBe(
      "sam [claude] (id: agent_1): idle (claims: none)"
    );
  });

  it("credits ownership to every agent sharing the owner's username, not just one agent id", () => {
    // The whole reason this matches on userName instead of agent id: the same person can be
    // running two agent processes (e.g. Claude Code in one worktree, Codex in another) that
    // both own whatever contracts that person owns.
    const contracts = [contract({ path: "contracts/api.ts", ownerUserName: "sam" })];
    const claudeAgent = agent({ id: "agent_claude", harness: "claude" });
    const codexAgent = agent({ id: "agent_codex", harness: "codex" });
    expect(formatAgentLine(claudeAgent, contracts)).toContain("(owns: contracts/api.ts)");
    expect(formatAgentLine(codexAgent, contracts)).toContain("(owns: contracts/api.ts)");
  });
});
