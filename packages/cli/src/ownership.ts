import type { Agent, Contract } from "@kingpost/protocol";

/** Renders one agent's status line for kingpost_who, appending which registered contracts
 * that agent's user currently owns (matched on username, not agent id — ownership is durable
 * per-user, not per-agent-process; ownerAgentId is transient and cleared on transfer). */
export function formatAgentLine(agent: Agent, contracts: Contract[]): string {
  const base = `${agent.userName} [${agent.harness}] (id: ${agent.id}): ${agent.statusText || "idle"} (claims: ${agent.claims.join(", ") || "none"})`;
  const owned = contracts
    .filter((c) => c.ownerUserName === agent.userName)
    .map((c) => c.path)
    .sort();
  return owned.length === 0 ? base : `${base} (owns: ${owned.join(", ")})`;
}
