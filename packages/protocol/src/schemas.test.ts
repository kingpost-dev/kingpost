import { describe, it, expect } from "vitest";
import { ContractSchema, ContractVersionSchema, ConsumerSchema, ProposalSchema, EventPayloadSchema } from "./schemas.js";

describe("ContractSchema", () => {
  it("parses a valid contract", () => {
    const result = ContractSchema.safeParse({
      id: "contract_1", path: "contracts/api.ts", format: "typescript", currentVersion: 2,
      ownerAgentId: "agent_1", ownerUserName: null, createdAt: "2026-09-28T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });
});

describe("ContractVersionSchema", () => {
  it("parses a valid version", () => {
    const result = ContractVersionSchema.safeParse({
      id: "cv_1", contractId: "contract_1", version: 1, contentSha256: "abc",
      content: "export type Foo = {}", updatedBy: "sam", breaking: false, diffSummary: null,
      createdAt: "2026-09-28T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });
});

describe("ConsumerSchema", () => {
  it("parses a declared consumer", () => {
    const result = ConsumerSchema.safeParse({
      id: "consumer_1", contractId: "contract_1", path: "client/api.ts",
      agentId: "agent_2", declared: true, createdAt: "2026-09-28T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });
});

describe("ProposalSchema", () => {
  it("parses and round-trips a valid proposal", () => {
    const proposal = {
      id: "p1", contractId: "c1", proposedByAgentId: "a1",
      newContent: "export type Foo = { bar: string };", rationale: "add bar field",
      status: "open", createdAt: "2026-01-01T00:00:00.000Z",
    };
    const result = ProposalSchema.safeParse(proposal);
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(proposal);
  });
});

describe("EventPayloadSchema proposal events", () => {
  const contract = {
    id: "contract_1", path: "contracts/api.ts", format: "typescript", currentVersion: 2,
    ownerAgentId: "agent_1", ownerUserName: "jack", createdAt: "2026-09-28T00:00:00.000Z",
  };
  const proposal = {
    id: "p1", contractId: "contract_1", proposedByAgentId: "agent_2",
    newContent: "export type Foo = { bar: string };", rationale: "add bar field",
    status: "open", createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("parses a proposal_created event", () => {
    const result = EventPayloadSchema.safeParse({
      type: "proposal_created", proposal, contract, consumerUserNames: ["alex", "sam"],
    });
    expect(result.success).toBe(true);
  });

  it("parses a proposal_accepted event", () => {
    const version = {
      id: "cv_1", contractId: "contract_1", version: 3, contentSha256: "abc",
      content: "export type Foo = { bar: string };", updatedBy: "agent_2", breaking: false,
      diffSummary: null, createdAt: "2026-01-01T00:01:00.000Z",
    };
    const result = EventPayloadSchema.safeParse({
      type: "proposal_accepted",
      proposal: { ...proposal, status: "accepted" },
      contract, version, consumerUserNames: ["alex", "sam"],
    });
    expect(result.success).toBe(true);
  });
});
