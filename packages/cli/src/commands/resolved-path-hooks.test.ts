import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertClaudeHooks, upsertCodexHooks } from "./resolved-path-hooks.js";

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
