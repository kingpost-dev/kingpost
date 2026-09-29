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

// "d\.ts" must come before "ts" in this alternation, or a declaration file's basename would
// only have its trailing ".ts" stripped (leaving a stray ".d" suffix) instead of the whole
// ".d.ts" — same class of bug this codebase already fixed once in match-contracts.ts's
// SOURCE_EXTENSIONS ordering. The `i` flag matters too: mentionsWord below matches
// case-insensitively, so an uppercase extension on a registered path (".TS") must still strip
// the same way, or basename matching would silently degrade for that one contract.
function contractBasename(p: string): string {
  const last = p.split("/").pop() ?? p;
  return last.replace(/\.(d\.ts|ts|tsx|js|jsx)$/i, "");
}

// A plain `\b` word boundary doesn't work here: contract paths/basenames routinely contain
// "/" and "." (non-word characters that are ALSO not boundary-adjacent in the way `\b` expects
// around them), so boundaries are hand-rolled via "not a word character" lookalikes instead.
function mentionsWord(text: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`, "i").test(text);
}

/** Finds a registered contract mentioned by full path or basename in free-form question text,
 * and returns the id of an online agent belonging to that contract's owner — or null if nothing
 * should be auto-routed (no mention, unowned contract, owner not currently online, or the only
 * matching agent is the asker). A full-path mention is checked first and, if found, is final —
 * it does NOT also fall through to a basename search that could match a different contract.
 *
 * Known limits, accepted for now (add real disambiguation by demand): if two contracts share a
 * basename and only the basename is mentioned, whichever is first in `contracts` wins — no
 * attempt at smarter tie-breaking. And a contract with a common basename (e.g. "index", "types")
 * will match constantly in ordinary prose, which can misroute an unrelated broadcast — there's
 * no minimum-specificity guard against short/generic basenames. */
export function routeQuestionTarget(
  text: string,
  contracts: Contract[],
  agents: Agent[],
  askingAgentId: string
): string | null {
  const byFullPath = contracts.find((c) => mentionsWord(text, c.path));
  const matched = byFullPath ?? contracts.find((c) => mentionsWord(text, contractBasename(c.path)));
  if (!matched || !matched.ownerUserName) return null;

  const owner = agents.find((a) => a.userName === matched.ownerUserName && a.id !== askingAgentId);
  return owner ? owner.id : null;
}
