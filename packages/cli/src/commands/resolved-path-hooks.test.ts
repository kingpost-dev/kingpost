import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertClaudeHooks, upsertCodexHooks, buildCodexHook } from "./resolved-path-hooks.js";

const ENTRY_PATH_A = "/opt/kingpost/dist/index.js";
const ENTRY_PATH_B = "/opt/kingpost-new/dist/index.js";
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"];

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("upsertClaudeHooks", () => {
  it("writes all 4 events into an absent .claude/settings.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    upsertClaudeHooks(dir, ENTRY_PATH_A);
    const settings = readJson(join(dir, ".claude", "settings.json"));

    for (const event of EVENTS) {
      expect(settings.hooks[event]).toHaveLength(1);
      const hook = settings.hooks[event][0].hooks[0];
      expect(hook.type).toBe("command");
      expect(hook.command).toBe(process.execPath);
      expect(hook.args).toEqual([ENTRY_PATH_A, "hook", event, "--harness", "claude"]);
    }
    expect(settings.hooks.SessionStart[0].matcher).toBe("startup|resume");
    expect(settings.hooks.UserPromptSubmit[0].matcher).toBeUndefined();
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Write|Edit");
  });

  it("preserves unrelated existing settings and hooks", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const settingsPath = join(dir, ".claude", "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          permissions: { allow: ["Bash(npm test)"] },
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
          },
        },
        null,
        2
      )
    );

    upsertClaudeHooks(dir, ENTRY_PATH_A);
    const settings = readJson(settingsPath);

    expect(settings.permissions).toEqual({ allow: ["Bash(npm test)"] });
    // Unrelated matcher group for the same event must survive untouched.
    const bashGroup = settings.hooks.PreToolUse.find((g: any) => g.matcher === "Bash");
    expect(bashGroup.hooks).toEqual([{ type: "command", command: "echo hi" }]);
    // Kingpost's own matcher group is added alongside it.
    const kingpostGroup = settings.hooks.PreToolUse.find((g: any) => g.matcher === "Write|Edit");
    expect(kingpostGroup.hooks[0].args).toEqual([ENTRY_PATH_A, "hook", "PreToolUse", "--harness", "claude"]);
  });

  it("does not duplicate entries when run twice, and updates paths in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    upsertClaudeHooks(dir, ENTRY_PATH_A);
    upsertClaudeHooks(dir, ENTRY_PATH_B);
    const settings = readJson(join(dir, ".claude", "settings.json"));

    for (const event of EVENTS) {
      expect(settings.hooks[event]).toHaveLength(1);
      expect(settings.hooks[event][0].hooks).toHaveLength(1);
      expect(settings.hooks[event][0].hooks[0].args[0]).toBe(ENTRY_PATH_B);
    }
  });
});

describe("buildCodexHook — Windows commandWindows override", () => {
  const WIN_NODE = "C:\\Program Files\\nodejs\\node.exe";
  const WIN_ENTRY = "C:\\Users\\Jackson\\AppData\\Roaming\\npm\\node_modules\\kingpost\\dist\\index.js";

  it("on win32, adds a PowerShell call-operator form with single-quoted literals", () => {
    const hook = buildCodexHook(WIN_ENTRY, "PreToolUse", "win32", WIN_NODE);
    // Must start with `&`: a PowerShell command string beginning with a quoted path is parsed as an
    // expression and never invoked — the failure this override exists to fix.
    expect(hook.commandWindows).toBe(`& '${WIN_NODE}' '${WIN_ENTRY}' hook PreToolUse --harness codex`);
    expect((hook.commandWindows as string).startsWith("& ")).toBe(true);
    // The plain `command` is still emitted for everything that doesn't use the Windows override.
    expect(hook.command).toBe(`"${WIN_NODE}" "${WIN_ENTRY}" hook PreToolUse --harness codex`);
  });

  it("doubles an embedded single quote so a path like C:\\Users\\O'Brien can't break out of the literal", () => {
    const hook = buildCodexHook("C:\\Users\\O'Brien\\kp\\index.js", "SessionStart", "win32", WIN_NODE);
    expect(hook.commandWindows).toBe(`& '${WIN_NODE}' 'C:\\Users\\O''Brien\\kp\\index.js' hook SessionStart --harness codex`);
  });

  it("does not interpolate $ in a path (single quotes, not double)", () => {
    const hook = buildCodexHook("C:\\Users\\a$b\\index.js", "PostToolUse", "win32", WIN_NODE);
    expect(hook.commandWindows).toContain("'C:\\Users\\a$b\\index.js'");
    expect(hook.commandWindows).not.toContain('"');
  });

  it.each(["darwin", "linux"] as const)("on %s, emits no commandWindows at all (output unchanged)", (platform) => {
    const hook = buildCodexHook("/opt/kingpost/dist/index.js", "PreToolUse", platform, "/usr/local/bin/node");
    expect(hook).toEqual({
      type: "command",
      command: `"/usr/local/bin/node" "/opt/kingpost/dist/index.js" hook PreToolUse --harness codex`,
      additionalContextLimit: 5000,
    });
    expect("commandWindows" in hook).toBe(false);
  });

  it("upsertCodexHooks on win32 writes commandWindows for every event, and re-running replaces rather than duplicates", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    upsertCodexHooks(dir, ENTRY_PATH_A, "win32");
    upsertCodexHooks(dir, ENTRY_PATH_B, "win32");
    const config = readJson(join(dir, ".codex", "hooks.json"));
    for (const event of EVENTS) {
      expect(config.hooks[event]).toHaveLength(1);
      expect(config.hooks[event][0].hooks).toHaveLength(1);
      const hook = config.hooks[event][0].hooks[0];
      expect(hook.commandWindows).toContain(`'${ENTRY_PATH_B}'`);
      expect(hook.commandWindows).not.toContain(ENTRY_PATH_A);
    }
  });
});

describe("upsertCodexHooks", () => {
  it("writes all 4 events into an absent .codex/hooks.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    upsertCodexHooks(dir, ENTRY_PATH_A);
    const config = readJson(join(dir, ".codex", "hooks.json"));

    for (const event of EVENTS) {
      expect(config.hooks[event]).toHaveLength(1);
      const hook = config.hooks[event][0].hooks[0];
      expect(hook.type).toBe("command");
      expect(hook.command).toBe(`"${process.execPath}" "${ENTRY_PATH_A}" hook ${event} --harness codex`);
      expect(hook.additionalContextLimit).toBe(5000);
    }
    expect(config.hooks.PreToolUse[0].matcher).toBe("apply_patch|Edit|Write|Bash");
  });

  it("preserves unrelated existing config", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    mkdirSync(join(dir, ".codex"), { recursive: true });
    const hooksPath = join(dir, ".codex", "hooks.json");
    writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
          },
        },
        null,
        2
      )
    );

    upsertCodexHooks(dir, ENTRY_PATH_A);
    const config = readJson(hooksPath);

    expect(config.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "echo done" }] }]);
    expect(config.hooks.SessionStart).toHaveLength(1);
  });

  it("does not duplicate entries when run twice, and updates paths in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    upsertCodexHooks(dir, ENTRY_PATH_A);
    upsertCodexHooks(dir, ENTRY_PATH_B);
    const config = readJson(join(dir, ".codex", "hooks.json"));

    for (const event of EVENTS) {
      expect(config.hooks[event]).toHaveLength(1);
      expect(config.hooks[event][0].hooks).toHaveLength(1);
      expect(config.hooks[event][0].hooks[0].command).toContain(ENTRY_PATH_B);
    }
  });
});
