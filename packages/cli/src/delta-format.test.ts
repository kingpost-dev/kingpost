import { describe, it, expect } from "vitest";
import { renderDeltaLines } from "./delta-format.js";
import type { Delta } from "@kingpost/protocol";

function emptyDelta(): Delta {
  return { contractsChanged: [], questionsForMe: [], answersToMe: [], findings: [], overlappingClaims: [] };
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
});
