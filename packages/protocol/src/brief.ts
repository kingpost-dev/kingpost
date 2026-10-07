import type { Agent, Contract, Question, Finding } from "./schemas.js";

const MAX_BRIEF_LINES = 30;

export interface BriefInput {
  agents: Agent[]; // other active agents (already excludes self)
  contracts: Contract[];
  openQuestions: Question[]; // already filtered to ones for me or the team
  recentFindings: Finding[]; // most recent first
}

export function renderBrief(input: BriefInput): string {
  // Always state the teammate count explicitly, even when zero — otherwise a fresh solo project
  // (the exact state every teammate starts in before others join) renders as a brief with no
  // "Active teammates" section at all, which reads as "nothing was delivered" rather than
  // "confirmed: you're alone right now" (observed repeatedly in real testing).
  const lines: string[] = ["## Kingpost brief", `${input.agents.length} teammate${input.agents.length === 1 ? "" : "s"} active`];

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
      lines.push(`- ${c.path} v${c.currentVersion} (by ${c.ownerUserName ?? "unknown"})`);
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

  lines.push(
    "Tools: kingpost_status, kingpost_who, kingpost_ask, kingpost_answer, kingpost_finding, kingpost_brief, kingpost_contracts, kingpost_contract, kingpost_consume, kingpost_scan, kingpost_transfer, kingpost_propose, kingpost_accept, kingpost_reject, kingpost_reply"
  );

  return lines.slice(0, MAX_BRIEF_LINES).join("\n");
}
