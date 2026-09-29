import { describe, it, expect } from "vitest";
import { formatAgentLine, routeQuestionTarget } from "./ownership.js";
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

describe("routeQuestionTarget", () => {
  const owner = agent({ id: "agent_owner", userName: "alex" });
  const asker = agent({ id: "agent_asker", userName: "sam" });
  const contracts = [contract({ path: "contracts/api.ts", ownerUserName: "alex" })];

  it("routes to the owner when the full path is mentioned", () => {
    expect(routeQuestionTarget("does contracts/api.ts support pagination?", contracts, [owner, asker], "agent_asker")).toBe("agent_owner");
  });

  it("routes to the owner when just the basename is mentioned", () => {
    expect(routeQuestionTarget("can api handle nulls?", contracts, [owner, asker], "agent_asker")).toBe("agent_owner");
  });

  it("does not match a substring inside an unrelated word", () => {
    expect(routeQuestionTarget("is the apiary schema done?", contracts, [owner, asker], "agent_asker")).toBeNull();
  });

  it("returns null when no contract is mentioned", () => {
    expect(routeQuestionTarget("how's it going?", contracts, [owner, asker], "agent_asker")).toBeNull();
  });

  it("returns null when the mentioned contract has no owner", () => {
    const unowned = [contract({ path: "contracts/api.ts", ownerUserName: null })];
    expect(routeQuestionTarget("about contracts/api.ts", unowned, [owner, asker], "agent_asker")).toBeNull();
  });

  it("returns null when the owner has no currently-online agent", () => {
    expect(routeQuestionTarget("about contracts/api.ts", contracts, [asker], "agent_asker")).toBeNull();
  });

  it("returns null when the only matching agent is the asker themself", () => {
    const selfOwned = [contract({ path: "contracts/api.ts", ownerUserName: "sam" })];
    expect(routeQuestionTarget("about contracts/api.ts", selfOwned, [asker], "agent_asker")).toBeNull();
  });

  it("prefers a full-path match over a basename match when both are present", () => {
    const two = [
      contract({ id: "c1", path: "contracts/api.ts", ownerUserName: "alex" }),
      contract({ id: "c2", path: "lib/api.ts", ownerUserName: "sam" }),
    ];
    // Mentions the full path of c2 (owned by sam, who is the asker). A full-path match must be
    // final and must NOT fall through to a basename search that could match c1 (owned by alex)
    // instead — that would silently misroute a question about lib/api.ts to the wrong contract's owner.
    expect(routeQuestionTarget("about lib/api.ts", two, [owner, asker], "agent_asker")).toBeNull();
  });

  it("matches case-insensitively", () => {
    expect(routeQuestionTarget("does CONTRACTS/API.TS support pagination?", contracts, [owner, asker], "agent_asker")).toBe("agent_owner");
  });

  it("strips a .d.ts extension fully (not just its trailing .ts) when matching by basename", () => {
    const dts = [contract({ path: "contracts/types.d.ts", ownerUserName: "alex" })];
    expect(routeQuestionTarget("does the types shape look right?", dts, [owner, asker], "agent_asker")).toBe("agent_owner");
  });

  it("strips a .d.ts extension case-insensitively", () => {
    const dts = [contract({ path: "contracts/Types.D.TS", ownerUserName: "alex" })];
    expect(routeQuestionTarget("does the types shape look right?", dts, [owner, asker], "agent_asker")).toBe("agent_owner");
  });
});
