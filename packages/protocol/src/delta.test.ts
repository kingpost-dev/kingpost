import { describe, it, expect } from "vitest";
import { computeDelta, deltaIsEmpty } from "./delta.js";
import type { Agent, Event } from "./schemas.js";

const baseAgent: Agent = {
  id: "agent-a",
  projectId: "p1",
  userName: "jack",
  harness: "claude",
  cwd: "/repo",
  statusText: "",
  claims: ["server/auth/*"],
  lastSeen: "2026-09-28T00:00:00.000Z",
  cursor: 0,
};

function contractEvent(id: number, agentId: string): Event {
  return {
    id,
    projectId: "p1",
    agentId,
    userName: null,
    createdAt: "2026-09-28T00:01:00.000Z",
    payload: {
      type: "contract_published",
      contract: {
        id: "contract_1",
        path: "contracts/api.ts",
        format: "unknown",
        currentVersion: 2,
        ownerAgentId: agentId,
        ownerUserName: null,
        createdAt: "2026-09-28T00:00:00.000Z",
      },
      version: {
        id: "cv_1",
        contractId: "contract_1",
        version: 2,
        contentSha256: "abc",
        content: "export type X = number;",
        updatedBy: agentId,
        createdAt: "2026-09-28T00:01:00.000Z",
      },
    },
  };
}

describe("computeDelta", () => {
  it("excludes the agent's own events", () => {
    const d = computeDelta(baseAgent, [contractEvent(1, "agent-a")]);
    expect(d.contractsChanged).toHaveLength(0);
  });

  it("includes another agent's contract change", () => {
    const d = computeDelta(baseAgent, [contractEvent(1, "agent-b")]);
    expect(d.contractsChanged).toHaveLength(1);
  });

  it("includes overlapping claims from another agent, not disjoint ones", () => {
    const overlapping: Event = {
      id: 2,
      projectId: "p1",
      agentId: "agent-b",
      userName: null,
      createdAt: "2026-09-28T00:02:00.000Z",
      payload: { type: "agent_status", agentId: "agent-b", statusText: "editing", claims: ["server/auth/login.ts"] },
    };
    const disjoint: Event = {
      ...overlapping,
      id: 3,
      payload: { type: "agent_status", agentId: "agent-b", statusText: "editing", claims: ["ui/App.vue"] },
    };
    const d = computeDelta(baseAgent, [overlapping, disjoint]);
    expect(d.overlappingClaims).toHaveLength(1);
  });

  it("is empty when there's nothing relevant", () => {
    const d = computeDelta(baseAgent, []);
    expect(deltaIsEmpty(d)).toBe(true);
  });
});

function proposalCreatedEvent(
  id: number,
  agentId: string,
  ownerUserName: string | null,
  consumerUserNames: string[]
): Event {
  return {
    id,
    projectId: "p1",
    agentId,
    userName: null,
    createdAt: "2026-09-28T00:03:00.000Z",
    payload: {
      type: "proposal_created",
      proposal: {
        id: "proposal_1",
        contractId: "contract_1",
        proposedByAgentId: agentId,
        newContent: "export type X = string;",
        rationale: "widen type",
        status: "open",
        createdAt: "2026-09-28T00:03:00.000Z",
      },
      contract: {
        id: "contract_1",
        path: "contracts/api.ts",
        format: "unknown",
        currentVersion: 2,
        ownerAgentId: "agent-owner",
        ownerUserName,
        createdAt: "2026-09-28T00:00:00.000Z",
      },
      consumerUserNames,
    },
  };
}

function proposalAcceptedEvent(
  id: number,
  agentId: string,
  ownerUserName: string | null,
  consumerUserNames: string[]
): Event {
  return {
    id,
    projectId: "p1",
    agentId,
    userName: null,
    createdAt: "2026-09-28T00:04:00.000Z",
    payload: {
      type: "proposal_accepted",
      proposal: {
        id: "proposal_1",
        contractId: "contract_1",
        proposedByAgentId: "agent-c",
        newContent: "export type X = string;",
        rationale: "widen type",
        status: "accepted",
        createdAt: "2026-09-28T00:03:00.000Z",
      },
      contract: {
        id: "contract_1",
        path: "contracts/api.ts",
        format: "unknown",
        currentVersion: 3,
        ownerAgentId: "agent-owner",
        ownerUserName,
        createdAt: "2026-09-28T00:00:00.000Z",
      },
      version: {
        id: "cv_1",
        contractId: "contract_1",
        version: 3,
        contentSha256: "abc",
        content: "export type X = string;",
        updatedBy: agentId,
        breaking: false,
        diffSummary: null,
        createdAt: "2026-09-28T00:04:00.000Z",
      },
      consumerUserNames,
    },
  };
}

describe("computeDelta proposal events", () => {
  it("notifies the contract owner of a proposal_created event", () => {
    const d = computeDelta(baseAgent, [proposalCreatedEvent(10, "agent-b", "jack", [])]);
    expect(d.proposalsForMe).toHaveLength(1);
  });

  it("notifies a consumer's owning userName of a proposal_created event, even if not the contract owner", () => {
    const d = computeDelta(baseAgent, [proposalCreatedEvent(10, "agent-b", "someone-else", ["jack"])]);
    expect(d.proposalsForMe).toHaveLength(1);
  });

  it("does not notify an agent who is neither the owner nor a listed consumer", () => {
    const d = computeDelta(baseAgent, [proposalCreatedEvent(10, "agent-b", "someone-else", ["another"])]);
    expect(d.proposalsForMe).toHaveLength(0);
  });

  it("does not notify the owner of their own proposal_created event", () => {
    const d = computeDelta(baseAgent, [proposalCreatedEvent(10, "agent-a", "jack", [])]);
    expect(d.proposalsForMe).toHaveLength(0);
  });

  it("notifies the contract owner of a proposal_accepted event", () => {
    const d = computeDelta(baseAgent, [proposalAcceptedEvent(10, "agent-b", "jack", [])]);
    expect(d.proposalsAcceptedForMe).toHaveLength(1);
  });

  it("notifies a consumer's owning userName of a proposal_accepted event, even if not the contract owner", () => {
    const d = computeDelta(baseAgent, [proposalAcceptedEvent(10, "agent-b", "someone-else", ["jack"])]);
    expect(d.proposalsAcceptedForMe).toHaveLength(1);
  });

  it("does not notify an agent who is neither the owner nor a listed consumer of proposal_accepted", () => {
    const d = computeDelta(baseAgent, [proposalAcceptedEvent(10, "agent-b", "someone-else", ["another"])]);
    expect(d.proposalsAcceptedForMe).toHaveLength(0);
  });

  it("does not notify the accepting agent of their own proposal_accepted event", () => {
    const d = computeDelta(baseAgent, [proposalAcceptedEvent(10, "agent-a", "jack", [])]);
    expect(d.proposalsAcceptedForMe).toHaveLength(0);
  });

  it("deltaIsEmpty is false when only proposalsForMe has an entry", () => {
    const d = computeDelta(baseAgent, [proposalCreatedEvent(10, "agent-b", "jack", [])]);
    expect(deltaIsEmpty(d)).toBe(false);
  });

  it("deltaIsEmpty is false when only proposalsAcceptedForMe has an entry", () => {
    const d = computeDelta(baseAgent, [proposalAcceptedEvent(10, "agent-b", "jack", [])]);
    expect(deltaIsEmpty(d)).toBe(false);
  });
});
