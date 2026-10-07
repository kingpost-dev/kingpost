import { agentsMdBlockStatus, readProjectConfig, upsertAgentsMdBlock } from "../config.js";
import { AGENTS_MD_BLOCK } from "./agents-md-block.js";
import { writeResolvedPathHooks } from "./resolved-path-hooks.js";
import { writeResolvedPathMcpConfig } from "./resolved-path-mcp.js";

/** Brings an already-set-up project up to date with the installed Kingpost: the AGENTS.md block (its wording
 * changes between releases, and `init` refuses to run twice) and the hook/MCP configs (which hold absolute
 * paths to this install). Touches nothing outside the Kingpost block and Kingpost's own config entries. */
export function updateCommand(cwd: string = process.cwd()): void {
  if (!readProjectConfig(cwd)) {
    console.error("No .kingpost.json in this directory — run 'kingpost init' or 'kingpost join <link>' first.");
    process.exitCode = 1;
    return;
  }

  const before = agentsMdBlockStatus(cwd, AGENTS_MD_BLOCK);
  upsertAgentsMdBlock(cwd, AGENTS_MD_BLOCK);
  writeResolvedPathHooks(cwd);
  writeResolvedPathMcpConfig(cwd);

  console.log(
    before === "current"
      ? "AGENTS.md: the Kingpost block is already up to date."
      : before === "missing"
        ? "AGENTS.md: added the Kingpost block."
        : "AGENTS.md: updated the Kingpost block to the current version."
  );
  console.log("Hook and MCP configs: refreshed with this install's paths.");
}
