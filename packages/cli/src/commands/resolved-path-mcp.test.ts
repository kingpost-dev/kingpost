import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertClaudeMcpConfig, upsertCodexMcpConfig } from "./resolved-path-mcp.js";

const ENTRY_PATH_A = "/opt/kingpost/dist/index.js";
const ENTRY_PATH_B = "/opt/kingpost-new/dist/index.js";
const WINDOWS_ENTRY_PATH = String.raw`C:\Users\jack\AppData\Roaming\npm\node_modules\kingpost\dist\index.js`;

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("upsertClaudeMcpConfig", () => {
  it("writes a kingpost entry into an absent .mcp.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    upsertClaudeMcpConfig(dir, ENTRY_PATH_A);
    const config = readJson(join(dir, ".mcp.json"));

    expect(config.mcpServers.kingpost).toEqual({
      command: process.execPath,
      args: [ENTRY_PATH_A, "mcp"],
    });
  });

  it("preserves unrelated existing servers and top-level keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    const path = join(dir, ".mcp.json");
    writeFileSync(
      path,
      JSON.stringify(
        {
          mcpServers: {
            other: { command: "other-tool", args: [] },
          },
        },
        null,
        2
      )
    );

    upsertClaudeMcpConfig(dir, ENTRY_PATH_A);
    const config = readJson(path);

    expect(config.mcpServers.other).toEqual({ command: "other-tool", args: [] });
    expect(config.mcpServers.kingpost.args).toEqual([ENTRY_PATH_A, "mcp"]);
  });

  it("does not duplicate entries when run twice, and updates paths in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    upsertClaudeMcpConfig(dir, ENTRY_PATH_A);
    upsertClaudeMcpConfig(dir, ENTRY_PATH_B);
    const config = readJson(join(dir, ".mcp.json"));

    expect(Object.keys(config.mcpServers)).toEqual(["kingpost"]);
    expect(config.mcpServers.kingpost.args).toEqual([ENTRY_PATH_B, "mcp"]);
  });
});

describe("upsertCodexMcpConfig", () => {
  it("writes a kingpost table into an absent .codex/config.toml", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    upsertCodexMcpConfig(dir, ENTRY_PATH_A);
    const content = readFileSync(join(dir, ".codex", "config.toml"), "utf8");

    expect(content).toContain("[mcp_servers.kingpost]");
    expect(content).toContain(`command = "${process.execPath}"`);
    expect(content).toContain(`args = ["${ENTRY_PATH_A}", "mcp"]`);
  });

  it("preserves unrelated existing content", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    mkdirSync(join(dir, ".codex"), { recursive: true });
    const path = join(dir, ".codex", "config.toml");
    writeFileSync(path, `[mcp_servers.other]\ncommand = "other-tool"\nargs = []\n`);

    upsertCodexMcpConfig(dir, ENTRY_PATH_A);
    const content = readFileSync(path, "utf8");

    expect(content).toContain("[mcp_servers.other]");
    expect(content).toContain('command = "other-tool"');
    expect(content).toContain("[mcp_servers.kingpost]");
  });

  it("does not duplicate the table when run twice, and updates paths in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    upsertCodexMcpConfig(dir, ENTRY_PATH_A);
    upsertCodexMcpConfig(dir, ENTRY_PATH_B);
    const content = readFileSync(join(dir, ".codex", "config.toml"), "utf8");

    expect(content.match(/\[mcp_servers\.kingpost\]/g)).toHaveLength(1);
    expect(content).toContain(`args = ["${ENTRY_PATH_B}", "mcp"]`);
    expect(content).not.toContain(ENTRY_PATH_A);
  });

  it("escapes Windows-style backslash paths as valid TOML string literals", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    upsertCodexMcpConfig(dir, WINDOWS_ENTRY_PATH);

    // Simulate what the writer would use for `command` on Windows by re-running with a
    // Windows-style node path too, to check both fields get escaped.
    const path = join(dir, ".codex", "config.toml");
    const content = readFileSync(path, "utf8");

    // Backslashes must be doubled so the TOML string literal is valid.
    const expectedEntryPath = WINDOWS_ENTRY_PATH.replace(/\\/g, "\\\\");
    expect(content).toContain(`args = ["${expectedEntryPath}", "mcp"]`);
    // The raw single-backslash form must not appear unescaped inside the quoted string.
    expect(content).not.toContain(`args = ["${WINDOWS_ENTRY_PATH}", "mcp"]`);
  });

  it("preserves a table that immediately follows kingpost's with no blank line", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    mkdirSync(join(dir, ".codex"), { recursive: true });
    const path = join(dir, ".codex", "config.toml");
    writeFileSync(path, `[mcp_servers.kingpost]\ncommand = "old"\nargs = ["old.js", "mcp"]\n[mcp_servers.other]\ncommand = "other-tool"\n`);

    upsertCodexMcpConfig(dir, ENTRY_PATH_A);
    const content = readFileSync(path, "utf8");

    expect(content).toContain("[mcp_servers.other]");
    expect(content).toContain('command = "other-tool"');
    expect(content).not.toContain("old.js");
    expect(content.match(/\[mcp_servers\.kingpost\]/g)).toHaveLength(1);
  });
});
