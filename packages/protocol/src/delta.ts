import type { Event, Agent } from "./schemas.js";
import { anyOverlap } from "./overlap.js";

export interface Delta {
  contractsChanged: Extract<Event["payload"], { type: "contract_published" }>[];
  questionsForMe: Extract<Event["payload"], { type: "question_asked" }>[];
  answersToMe: Extract<Event["payload"], { type: "question_answered" }>[];
  findings: Extract<Event["payload"], { type: "finding_published" }>[];
  overlappingClaims: Extract<Event["payload"], { type: "agent_status" }>[];
  proposalsForMe: Extract<Event["payload"], { type: "proposal_created" }>[];
  proposalsAcceptedForMe: Extract<Event["payload"], { type: "proposal_accepted" }>[];
}

/** Events must be pre-sorted ascending by id and already filtered to events with id > agent.cursor. */
export function computeDelta(agent: Agent, eventsSinceCursor: Event[]): Delta {
  const delta: Delta = {
    contractsChanged: [],
    questionsForMe: [],
    answersToMe: [],
    findings: [],
    overlappingClaims: [],
    proposalsForMe: [],
    proposalsAcceptedForMe: [],
  };

  const myOpenQuestionIds = new Set(
    eventsSinceCursor
      .filter((e) => e.payload.type === "question_asked" && e.agentId === agent.id)
      .map((e) => (e.payload as { type: "question_asked"; question: { id: string } }).question.id)
  );

  for (const e of eventsSinceCursor) {
    if (e.agentId === agent.id) continue; // never see your own events
    const p = e.payload;
    switch (p.type) {
      case "contract_published":
        delta.contractsChanged.push(p);
        break;
      case "question_asked":
        if (p.question.toAgentId === null || p.question.toAgentId === agent.id) {
          delta.questionsForMe.push(p);
        }
        break;
      case "question_answered":
        if (myOpenQuestionIds.has(p.question.id) || p.question.fromAgentId === agent.id) {
          delta.answersToMe.push(p);
        }
        break;
      case "finding_published":
        delta.findings.push(p);
        break;
      case "agent_status":
        if (anyOverlap(agent.claims, p.claims)) {
          delta.overlappingClaims.push(p);
        }
        break;
      case "proposal_created":
        if (p.contract.ownerUserName === agent.userName || p.consumerUserNames.includes(agent.userName)) {
          delta.proposalsForMe.push(p);
        }
        break;
      case "proposal_accepted":
        if (p.contract.ownerUserName === agent.userName || p.consumerUserNames.includes(agent.userName)) {
          delta.proposalsAcceptedForMe.push(p);
        }
        break;
      case "agent_registered":
        break;
    }
  }
  return delta;
}

export function deltaIsEmpty(d: Delta): boolean {
  return (
    d.contractsChanged.length === 0 &&
    d.questionsForMe.length === 0 &&
    d.answersToMe.length === 0 &&
    d.findings.length === 0 &&
    d.overlappingClaims.length === 0 &&
    d.proposalsForMe.length === 0 &&
    d.proposalsAcceptedForMe.length === 0
  );
}
