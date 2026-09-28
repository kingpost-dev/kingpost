import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProjectConfig, readProjectConfig, upsertAgentsMdBlock } from "./config.js";

describe("project config", () => {
  it("round-trips through .kingpost.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    writeProjectConfig(dir, { serverUrl: "https://app.kingpost.dev", projectId: "proj_abc" });
    const read = readProjectConfig(dir);
    expect(read).toEqual({ serverUrl: "https://app.kingpost.dev", projectId: "proj_abc" });
  });

  it("returns null when no config exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    expect(readProjectConfig(dir)).toBeNull();
  });
});

describe("AGENTS.md block", () => {
  it("inserts a marked block into a fresh file", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    upsertAgentsMdBlock(dir, "Kingpost instructions here.");
    const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(content).toContain("Kingpost instructions here.");
    expect(content).toContain("<!-- kingpost:start -->");
  });

  it("replaces an existing block in place on a second call", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    upsertAgentsMdBlock(dir, "first version");
    upsertAgentsMdBlock(dir, "second version");
    const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(content).not.toContain("first version");
    expect(content).toContain("second version");
    expect(content.match(/kingpost:start/g)?.length).toBe(1);
  });
});
