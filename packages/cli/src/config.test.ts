import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProjectConfig, readProjectConfig, upsertAgentsMdBlock, readCredentials, writeCredential, getToken } from "./config.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

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

describe("credentials", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function useTempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "kp-home-"));
    vi.mocked(os.homedir).mockReturnValue(dir);
    return dir;
  }

  it("stores and retrieves a token by project id", () => {
    useTempHome();
    writeCredential("proj_a", "token_a");
    expect(getToken("proj_a")).toBe("token_a");
  });

  it("preserves an existing project's token when a second project is added", () => {
    useTempHome();
    writeCredential("proj_a", "token_a");
    writeCredential("proj_b", "token_b");
    expect(getToken("proj_a")).toBe("token_a");
    expect(getToken("proj_b")).toBe("token_b");
    expect(readCredentials()).toEqual({
      proj_a: { token: "token_a" },
      proj_b: { token: "token_b" },
    });
  });

  it("returns null for a project with no stored token", () => {
    useTempHome();
    expect(getToken("nonexistent")).toBeNull();
  });
});
