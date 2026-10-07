import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProjectConfig, upsertAgentsMdBlock } from "../config.js";
import { AGENTS_MD_BLOCK } from "./agents-md-block.js";
import { updateCommand } from "./update.js";

describe("updateCommand", () => {
  let dir: string;
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kp-update-"));
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("replaces an outdated Kingpost block with the current one and keeps the rest of AGENTS.md", () => {
    writeProjectConfig(dir, { serverUrl: "https://example.invalid", projectId: "proj_1" });
    writeFileSync(join(dir, "AGENTS.md"), "# My notes\n\nKeep this.\n");
    upsertAgentsMdBlock(dir, "an older version of the Kingpost instructions");
    writeFileSync(join(dir, "AGENTS.md"), readFileSync(join(dir, "AGENTS.md"), "utf8") + "\nAnd this, after the block.\n");

    updateCommand(dir);

    const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(content).toContain(AGENTS_MD_BLOCK);
    expect(content).not.toContain("an older version");
    expect(content).toContain("Keep this.");
    expect(content).toContain("And this, after the block.");
    expect(content.match(/kingpost:start/g)).toHaveLength(1);
    expect(log.mock.calls.flat().join("\n")).toContain("updated the Kingpost block");
  });

  it("adds the block when AGENTS.md has none, and says it is up to date when run again", () => {
    writeProjectConfig(dir, { serverUrl: "https://example.invalid", projectId: "proj_1" });
    updateCommand(dir);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain(AGENTS_MD_BLOCK);
    expect(log.mock.calls.flat().join("\n")).toContain("added the Kingpost block");

    log.mockClear();
    updateCommand(dir);
    expect(log.mock.calls.flat().join("\n")).toContain("already up to date");
  });

  it("refreshes the hook and MCP configs with this install's paths", () => {
    writeProjectConfig(dir, { serverUrl: "https://example.invalid", projectId: "proj_1" });
    updateCommand(dir);
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(dir, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
  });

  it("refuses, writing nothing, in a directory that isn't a Kingpost project", () => {
    updateCommand(dir);
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls.flat().join("\n")).toContain("kingpost init");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
  });
});
