import { describe, it, expect } from "vitest";
import { renderDeltaLines } from "./delta-format.js";
import type { Delta } from "@kingpost/protocol";

function emptyDelta(): Delta {
  return {
    contractsChanged: [],
    questionsForMe: [],
    answersToMe: [],
    findings: [],
    overlappingClaims: [],
    proposalsForMe: [],
    proposalsAcceptedForMe: [],
  };
}

describe("renderDeltaLines", () => {
  it("flags a breaking contract change with the diff summary", () => {
    const delta = emptyDelta();
    delta.contractsChanged.push({
      type: "contract_published",
      contract: { id: "contract_1", path: "contracts/api.json", format: "json-schema", currentVersion: 2, ownerAgentId: "agent_1", ownerUserName: null, createdAt: "2026-09-29T00:00:00.000Z" },
      version: { id: "cv_2", contractId: "contract_1", version: 2, contentSha256: "abc", content: "{}", updatedBy: "sam", breaking: true, diffSummary: "removed field X", createdAt: "2026-09-29T00:00:00.000Z" },
    });
    const lines = renderDeltaLines(delta);
    expect(lines).toEqual(["Contract updated: contracts/api.json v2 ⚠ BREAKING: removed field X"]);
  });

  it("does not flag a non-breaking contract change", () => {
    const delta = emptyDelta();
    delta.contractsChanged.push({
      type: "contract_published",
      contract: { id: "contract_1", path: "contracts/api.json", format: "json-schema", currentVersion: 2, ownerAgentId: "agent_1", ownerUserName: null, createdAt: "2026-09-29T00:00:00.000Z" },
      version: { id: "cv_2", contractId: "contract_1", version: 2, contentSha256: "abc", content: "{}", updatedBy: "sam", breaking: false, diffSummary: null, createdAt: "2026-09-29T00:00:00.000Z" },
    });
    const lines = renderDeltaLines(delta);
    expect(lines).toEqual(["Contract updated: contracts/api.json v2"]);
  });

  it("renders a proposal for you", () => {
    const delta = emptyDelta();
    delta.proposalsForMe.push({
      type: "proposal_created",
      proposal: { id: "proposal_1", contractId: "contract_1", proposedByAgentId: "agent_2", newContent: "{}", rationale: "tighten validation", status: "open", createdAt: "2026-09-29T00:00:00.000Z" },
      contract: { id: "contract_1", path: "contracts/api.json", format: "json-schema", currentVersion: 2, ownerAgentId: "agent_1", ownerUserName: "sam", createdAt: "2026-09-29T00:00:00.000Z" },
      consumerUserNames: ["sam"],
    });
    const lines = renderDeltaLines(delta);
    expect(lines).toEqual(["Proposal for you: [proposal_1] change to contracts/api.json — tighten validation"]);
  });

  it("renders an accepted proposal", () => {
    const delta = emptyDelta();
    delta.proposalsAcceptedForMe.push({
      type: "proposal_accepted",
      proposal: { id: "proposal_1", contractId: "contract_1", proposedByAgentId: "agent_2", newContent: "{}", rationale: "tighten validation", status: "accepted", createdAt: "2026-09-29T00:00:00.000Z" },
      contract: { id: "contract_1", path: "contracts/api.json", format: "json-schema", currentVersion: 3, ownerAgentId: "agent_1", ownerUserName: "sam", createdAt: "2026-09-29T00:00:00.000Z" },
      version: { id: "cv_3", contractId: "contract_1", version: 3, contentSha256: "abc", content: "{}", updatedBy: "sam", breaking: false, diffSummary: null, createdAt: "2026-09-29T00:00:00.000Z" },
      consumerUserNames: ["sam"],
    });
    const lines = renderDeltaLines(delta);
    expect(lines).toEqual(["Proposal accepted: [proposal_1] contracts/api.json is now v3"]);
  });

  it("renders proposal fields alongside other delta fields", () => {
    const delta = emptyDelta();
    delta.findings.push({ type: "finding_published", finding: { id: "f1", agentId: "agent_2", text: "watch out for X", paths: [], createdAt: "2026-09-29T00:00:00.000Z" } });
    delta.proposalsForMe.push({
      type: "proposal_created",
      proposal: { id: "proposal_1", contractId: "contract_1", proposedByAgentId: "agent_2", newContent: "{}", rationale: "tighten validation", status: "open", createdAt: "2026-09-29T00:00:00.000Z" },
      contract: { id: "contract_1", path: "contracts/api.json", format: "json-schema", currentVersion: 2, ownerAgentId: "agent_1", ownerUserName: "sam", createdAt: "2026-09-29T00:00:00.000Z" },
      consumerUserNames: ["sam"],
    });
    const lines = renderDeltaLines(delta);
    expect(lines).toEqual(["Finding: watch out for X", "Proposal for you: [proposal_1] change to contracts/api.json — tighten validation"]);
  });
});
