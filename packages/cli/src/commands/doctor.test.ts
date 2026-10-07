import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertAgentsMdBlock } from "../config.js";
import { checkAgentsMdBlock, claudePostToolHookCoversShell, parseClaudeMcpApproval } from "./doctor.js";
import { upsertClaudeHooks } from "./resolved-path-hooks.js";
import { readFileSync } from "node:fs";

// Real output captured from Claude Code on Windows (`claude mcp get kingpost`).
const PENDING = `kingpost:
  Scope: Project config (shared via .mcp.json)
  Status: ⏸ Pending approval (run \`claude\` to approve)

To remove this server, run: claude mcp remove kingpost -s project
`;

describe("parseClaudeMcpApproval", () => {
  it("fails with the approval instruction when the server is pending approval", () => {
    const check = parseClaudeMcpApproval(PENDING);
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("run 'claude' in this directory and approve");
  });

  it("passes when the server has a status other than pending approval", () => {
    expect(parseClaudeMcpApproval("kingpost:\n  Scope: Project config\n  Status: ✓ Connected\n")?.ok).toBe(true);
  });

  it("is inconclusive (null) for output it doesn't recognise", () => {
    expect(parseClaudeMcpApproval("")).toBeNull();
    expect(parseClaudeMcpApproval("No MCP server found with name: kingpost")).toBeNull();
  });
});

describe("checkAgentsMdBlock", () => {
  it("passes when the block is current, and points at 'kingpost update' when it is missing or outdated", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-doctor-"));
    expect(checkAgentsMdBlock(dir, "now")).toMatchObject({ ok: false, detail: expect.stringContaining("kingpost update") });
    upsertAgentsMdBlock(dir, "before");
    expect(checkAgentsMdBlock(dir, "now")).toMatchObject({ ok: false, detail: expect.stringContaining("out of date") });
    upsertAgentsMdBlock(dir, "now");
    expect(checkAgentsMdBlock(dir, "now")).toEqual({ label: "AGENTS.md Kingpost block", ok: true });
  });
});

describe("claudePostToolHookCoversShell", () => {
  it("is true for hooks written by this version and false for ones from before shell-write detection", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-doctor-"));
    upsertClaudeHooks(dir, "/opt/kingpost/dist/index.js");
    expect(claudePostToolHookCoversShell(JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")))).toBe(true);

    // The same config as an older release wrote it: PostToolUse matched only Write|Edit.
    const old = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    old.hooks.PostToolUse[0].matcher = "Write|Edit";
    expect(claudePostToolHookCoversShell(old)).toBe(false);
  });

  it("is false when someone else's hook matches Bash but Kingpost's doesn't, and for missing config", () => {
    const foreign = { hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] } };
    expect(claudePostToolHookCoversShell(foreign)).toBe(false);
    expect(claudePostToolHookCoversShell({})).toBe(false);
    expect(claudePostToolHookCoversShell(null)).toBe(false);
  });
});
