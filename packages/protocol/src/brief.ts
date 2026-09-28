import type { Agent, Contract, Question, Finding } from "./schemas.js";

const MAX_BRIEF_LINES = 30;

export interface BriefInput {
  agents: Agent[]; // other active agents (already excludes self)
  contracts: Contract[];
  openQuestions: Question[]; // already filtered to ones for me or the team
  recentFindings: Finding[]; // most recent first
}

export function renderBrief(input: BriefInput): string {
  const lines: string[] = ["## Kingpost brief"];

  if (input.agents.length > 0) {
    lines.push("### Active teammates");
    for (const a of input.agents.slice(0, 8)) {
      const claims = a.claims.length > 0 ? ` (claims: ${a.claims.join(", ")})` : "";
      lines.push(`- ${a.userName} [${a.harness}]: ${a.statusText || "idle"}${claims}`);
    }
  }

  if (input.contracts.length > 0) {
    lines.push("### Contracts");
    for (const c of input.contracts.slice(0, 8)) {
      lines.push(`- ${c.path} v${c.version} (by ${c.updatedBy})`);
    }
  }

  if (input.openQuestions.length > 0) {
    lines.push("### Open questions");
    for (const q of input.openQuestions.slice(0, 6)) {
      lines.push(`- [${q.id}] ${q.text}`);
    }
  }

  if (input.recentFindings.length > 0) {
    lines.push("### Recent findings");
    for (const f of input.recentFindings.slice(0, 6)) {
      lines.push(`- ${f.text}`);
    }
  }

  lines.push("Tools: kingpost_status, kingpost_who, kingpost_ask, kingpost_answer, kingpost_finding, kingpost_brief");

  return lines.slice(0, MAX_BRIEF_LINES).join("\n");
}
