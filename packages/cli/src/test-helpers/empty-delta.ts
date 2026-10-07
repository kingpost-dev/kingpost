import type { Delta } from "@kingpost/protocol";

/** An empty Delta fixture, shared across test files so a new Delta field only needs adding in
 * one place — this list has already grown once (proposalsForMe/proposalsAcceptedForMe) and
 * previously required a separate hand-edit in every file with its own copy of this literal. */
export function emptyDelta(): Delta {
  return {
    contractsChanged: [],
    questionsForMe: [],
    answersToMe: [],
    findings: [],
    overlappingClaims: [],
    proposalsForMe: [],
    proposalsAcceptedForMe: [],
    proposalsRejectedForMe: [],
    proposalRepliesForMe: [],
  };
}
