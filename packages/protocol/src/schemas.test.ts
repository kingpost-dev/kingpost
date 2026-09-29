import { describe, it, expect } from "vitest";
import { ContractSchema, ContractVersionSchema, ConsumerSchema } from "./schemas.js";

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
