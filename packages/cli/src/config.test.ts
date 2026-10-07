import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProjectConfig, readProjectConfig, upsertAgentsMdBlock, agentsMdBlockStatus, upsertGitignoreEntries, GITIGNORE_ENTRIES, readCredentials, writeCredential, getToken } from "./config.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

describe("project config", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("returns null and warns when .kingpost.json contains invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    writeFileSync(join(dir, ".kingpost.json"), "{ not valid json");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readProjectConfig(dir)).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("invalid JSON"));
    errorSpy.mockRestore();
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

describe("upsertGitignoreEntries", () => {
  const gitRepo = () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-gi-"));
    mkdirSync(join(dir, ".git"));
    return dir;
  };
  const lines = (dir: string) => readFileSync(join(dir, ".gitignore"), "utf8").split("\n");

  it("creates .gitignore with the per-machine Kingpost files in a git repo", () => {
    const dir = gitRepo();
    const added = upsertGitignoreEntries(dir);
    expect(added).toEqual(GITIGNORE_ENTRIES);
    for (const entry of GITIGNORE_ENTRIES) expect(lines(dir)).toContain(entry);
  });

  it("leaves a directory that isn't in a git repo alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-gi-"));
    expect(upsertGitignoreEntries(dir)).toEqual([]);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  it("finds the repo from a subdirectory", () => {
    const root = gitRepo();
    const sub = join(root, "packages", "app");
    mkdirSync(sub, { recursive: true });
    expect(upsertGitignoreEntries(sub)).toEqual(GITIGNORE_ENTRIES);
    expect(existsSync(join(sub, ".gitignore"))).toBe(true);
  });

  it("keeps what is already in .gitignore, even without a trailing newline, and appends after it", () => {
    const dir = gitRepo();
    writeFileSync(join(dir, ".gitignore"), "node_modules\ndist");
    upsertGitignoreEntries(dir);
    const out = lines(dir);
    expect(out.slice(0, 2)).toEqual(["node_modules", "dist"]);
    expect(out).toContain(".kingpost.json");
  });

  it("adds only what is missing, counting a broader existing pattern as covering a file", () => {
    const dir = gitRepo();
    writeFileSync(join(dir, ".gitignore"), "/.kingpost.json\n.claude/\n");
    const added = upsertGitignoreEntries(dir);
    expect(added).not.toContain(".kingpost.json"); // present, with a leading slash
    expect(added).not.toContain(".claude/settings.json"); // covered by .claude/
    expect(added).toContain(".mcp.json");
    expect(lines(dir).filter((l) => l.replace(/^\//, "") === ".kingpost.json")).toHaveLength(1);
  });

  it("is idempotent: a second call changes nothing", () => {
    const dir = gitRepo();
    upsertGitignoreEntries(dir);
    const before = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(upsertGitignoreEntries(dir)).toEqual([]);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(before);
  });
});

describe("agentsMdBlockStatus", () => {
  it("is 'missing' when there is no AGENTS.md or no Kingpost block in it", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    expect(agentsMdBlockStatus(dir, "current")).toBe("missing");
    writeFileSync(join(dir, "AGENTS.md"), "# Project notes\n");
    expect(agentsMdBlockStatus(dir, "current")).toBe("missing");
  });

  it("is 'current' when the block matches, and 'outdated' once the wording changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    upsertAgentsMdBlock(dir, "version one");
    expect(agentsMdBlockStatus(dir, "version one")).toBe("current");
    expect(agentsMdBlockStatus(dir, "version two")).toBe("outdated");
  });

  it("ignores everything outside the markers", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-"));
    writeFileSync(join(dir, "AGENTS.md"), "# My own notes\n\nSome rules.\n");
    upsertAgentsMdBlock(dir, "version one");
    writeFileSync(join(dir, "AGENTS.md"), readFileSync(join(dir, "AGENTS.md"), "utf8") + "\nMore notes after the block.\n");
    expect(agentsMdBlockStatus(dir, "version one")).toBe("current");
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

  it("returns empty object and warns when credentials.json contains invalid JSON", () => {
    const home = useTempHome();
    const dir = join(home, ".config", "kingpost");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "credentials.json"), "{ not valid json");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readCredentials()).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("invalid JSON"));
    errorSpy.mockRestore();
  });
});
