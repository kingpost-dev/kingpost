import { describe, it, expect } from "vitest";
import { renderDeltaLines } from "./delta-format.js";
import { emptyDelta } from "./test-helpers/empty-delta.js";

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
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Proposal for you: [proposal_1] change to contracts/api.json — tighten validation.");
    // The line says what to do about it, and that it must be dealt with before the turn ends.
    expect(lines[0]).toContain("kingpost_proposal");
    expect(lines[0]).toContain("kingpost_accept");
    expect(lines[0]).toContain("kingpost_reject");
    expect(lines[0]).toContain("before you end your turn");
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

  it("renders a rejected proposal with the owner's reason", () => {
    const delta = emptyDelta();
    delta.proposalsRejectedForMe.push({
      type: "proposal_rejected",
      proposal: { id: "proposal_1", contractId: "contract_1", proposedByAgentId: "agent_2", newContent: "{}", rationale: "tighten validation", status: "rejected", rejectionReason: "breaks billing", createdAt: "2026-09-29T00:00:00.000Z" },
      contract: { id: "contract_1", path: "contracts/api.json", format: "json-schema", currentVersion: 2, ownerAgentId: "agent_1", ownerUserName: "sam", createdAt: "2026-09-29T00:00:00.000Z" },
      consumerUserNames: [],
    });
    expect(renderDeltaLines(delta)).toEqual(["Proposal rejected: [proposal_1] change to contracts/api.json was turned down — breaks billing"]);
  });

  it("renders a reply on a proposal with who wrote it", () => {
    const delta = emptyDelta();
    delta.proposalRepliesForMe.push({
      type: "proposal_replied",
      proposal: { id: "proposal_1", contractId: "contract_1", proposedByAgentId: "agent_2", newContent: "{}", rationale: "tighten validation", status: "open", createdAt: "2026-09-29T00:00:00.000Z" },
      contract: { id: "contract_1", path: "contracts/api.json", format: "json-schema", currentVersion: 2, ownerAgentId: "agent_1", ownerUserName: "sam", createdAt: "2026-09-29T00:00:00.000Z" },
      reply: { id: "reply_1", proposalId: "proposal_1", byAgentId: "agent_3", byUserName: "carol", text: "keep id optional?", createdAt: "2026-09-29T00:00:00.000Z" },
      consumerUserNames: [],
    });
    expect(renderDeltaLines(delta)).toEqual(["Reply on proposal [proposal_1] (contracts/api.json) from carol: keep id optional?"]);
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
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Finding: watch out for X");
    expect(lines[1]).toContain("Proposal for you: [proposal_1] change to contracts/api.json — tighten validation.");
  });
});
