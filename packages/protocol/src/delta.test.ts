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
        path: "contracts/api.ts",
        version: 2,
        contentSha256: "abc",
        content: "export type X = number;",
        updatedBy: agentId,
        updatedAt: "2026-09-28T00:01:00.000Z",
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
