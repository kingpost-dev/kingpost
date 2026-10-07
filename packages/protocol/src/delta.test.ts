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

// ---- proposal feedback: who is told about acceptance, rejection and replies ----
// "Related" = the contract's owner, its consumers, and whoever proposed. The actor never sees their own event.

const PROPOSER = "agent-proposer";

function proposalDecisionEvent(
  type: "proposal_accepted" | "proposal_rejected",
  id: number,
  actorAgentId: string | null,
  ownerUserName: string | null,
  consumerUserNames: string[]
): Event {
  const proposal = {
    id: "proposal_1",
    contractId: "contract_1",
    proposedByAgentId: PROPOSER,
    newContent: "export type X = string;",
    rationale: "widen type",
    status: type === "proposal_accepted" ? ("accepted" as const) : ("rejected" as const),
    rejectionReason: type === "proposal_rejected" ? "breaks billing" : null,
    createdAt: "2026-09-28T00:03:00.000Z",
  };
  const contract = {
    id: "contract_1",
    path: "contracts/api.ts",
    format: "unknown",
    currentVersion: 2,
    ownerAgentId: "agent-owner",
    ownerUserName,
    createdAt: "2026-09-28T00:00:00.000Z",
  };
  const version = {
    id: "cv_1",
    contractId: "contract_1",
    version: 3,
    contentSha256: "abc",
    content: "export type X = string;",
    updatedBy: "owner",
    breaking: false,
    diffSummary: null,
    createdAt: "2026-09-28T00:04:00.000Z",
  };
  return {
    id,
    projectId: "p1",
    agentId: actorAgentId,
    userName: null,
    createdAt: "2026-09-28T00:04:00.000Z",
    payload:
      type === "proposal_accepted"
        ? { type, proposal, contract, version, consumerUserNames }
        : { type, proposal, contract, consumerUserNames },
  };
}

function proposalRepliedEvent(id: number, actorAgentId: string, ownerUserName: string | null, consumerUserNames: string[]): Event {
  return {
    id,
    projectId: "p1",
    agentId: actorAgentId,
    userName: null,
    createdAt: "2026-09-28T00:05:00.000Z",
    payload: {
      type: "proposal_replied",
      proposal: {
        id: "proposal_1",
        contractId: "contract_1",
        proposedByAgentId: PROPOSER,
        newContent: "export type X = string;",
        rationale: "widen type",
        status: "open",
        rejectionReason: null,
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
      reply: { id: "reply_1", proposalId: "proposal_1", byAgentId: actorAgentId, byUserName: "someone", text: "keep id optional?", createdAt: "2026-09-28T00:05:00.000Z" },
      consumerUserNames,
    },
  };
}

const proposerAgent: Agent = { ...baseAgent, id: PROPOSER, userName: "proposer-user", claims: [] };

describe("computeDelta proposal acceptance reaches the proposer", () => {
  it("notifies the proposer even though they are neither owner nor consumer", () => {
    const d = computeDelta(proposerAgent, [proposalDecisionEvent("proposal_accepted", 10, "agent-owner", "jack", [])]);
    expect(d.proposalsAcceptedForMe).toHaveLength(1);
  });

  it("does not show the accepting owner their own acceptance", () => {
    const d = computeDelta(baseAgent, [proposalDecisionEvent("proposal_accepted", 10, baseAgent.id, "jack", [])]);
    expect(d.proposalsAcceptedForMe).toHaveLength(0);
  });
});

describe("computeDelta proposal rejection", () => {
  it("notifies the proposer, the consumers and the owner, but not the one who rejected", () => {
    const rejected = proposalDecisionEvent("proposal_rejected", 10, "agent-owner", "owner-user", ["jack"]);
    expect(computeDelta(proposerAgent, [rejected]).proposalsRejectedForMe).toHaveLength(1); // proposer
    expect(computeDelta(baseAgent, [rejected]).proposalsRejectedForMe).toHaveLength(1); // consumer "jack"
    const ownerSelf = { ...baseAgent, id: "agent-owner", userName: "owner-user" };
    expect(computeDelta(ownerSelf, [rejected]).proposalsRejectedForMe).toHaveLength(0); // the actor
  });

  it("does not notify an unrelated agent", () => {
    const d = computeDelta({ ...baseAgent, userName: "stranger" }, [proposalDecisionEvent("proposal_rejected", 10, "agent-owner", "owner-user", ["jack"])]);
    expect(d.proposalsRejectedForMe).toHaveLength(0);
  });

  it("carries the reason through", () => {
    const d = computeDelta(proposerAgent, [proposalDecisionEvent("proposal_rejected", 10, "agent-owner", "owner-user", [])]);
    expect(d.proposalsRejectedForMe[0].proposal.rejectionReason).toBe("breaks billing");
  });
});

describe("computeDelta proposal replies", () => {
  it("notifies the owner, a consumer and the proposer, but never the replier", () => {
    const reply = proposalRepliedEvent(10, "agent-replier", "owner-user", ["jack"]);
    expect(computeDelta({ ...baseAgent, userName: "owner-user" }, [reply]).proposalRepliesForMe).toHaveLength(1);
    expect(computeDelta(baseAgent, [reply]).proposalRepliesForMe).toHaveLength(1); // consumer
    expect(computeDelta(proposerAgent, [reply]).proposalRepliesForMe).toHaveLength(1);
    expect(computeDelta({ ...baseAgent, id: "agent-replier" }, [reply]).proposalRepliesForMe).toHaveLength(0);
  });

  it("does not notify an unrelated agent", () => {
    const d = computeDelta({ ...baseAgent, userName: "stranger" }, [proposalRepliedEvent(10, "agent-replier", "owner-user", ["jack"])]);
    expect(d.proposalRepliesForMe).toHaveLength(0);
  });
});

describe("deltaIsEmpty with proposal feedback", () => {
  it("is not empty when only a rejection or a reply is pending", () => {
    expect(deltaIsEmpty(computeDelta(proposerAgent, [proposalDecisionEvent("proposal_rejected", 10, "agent-owner", "o", [])]))).toBe(false);
    expect(deltaIsEmpty(computeDelta(proposerAgent, [proposalRepliedEvent(10, "agent-replier", "o", [])]))).toBe(false);
  });
});
