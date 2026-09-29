import { describe, it, expect, vi, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which, joinCommand } from "./join.js";
import { scanRepo } from "../scan/scan-repo.js";
import { ApiClient } from "../api.js";

vi.mock("../scan/scan-repo.js", () => ({ scanRepo: vi.fn() }));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

describe("which", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(execSync).mockReset();
  });

  it("uses 'where' on win32", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(execSync).mockReturnValue(Buffer.from(""));
    expect(which("claude")).toBe(true);
    expect(execSync).toHaveBeenCalledWith("where claude", { stdio: "ignore" });
  });

  it("uses 'command -v' on posix", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.mocked(execSync).mockReturnValue(Buffer.from(""));
    expect(which("claude")).toBe(true);
    expect(execSync).toHaveBeenCalledWith("command -v claude", { stdio: "ignore" });
  });

  it("returns false when the probe command throws", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("not found");
    });
    expect(which("codex")).toBe(false);
  });
});

describe("joinCommand — initial full-repo consumer scan", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(scanRepo).mockReset();
  });

  it("scans the repo with a null agentId (no agent is registered yet at join time)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(scanRepo).mockResolvedValue(2);
    const cwd = mkdtempSync(join(tmpdir(), "kp-join-scan-"));
    await joinCommand("https://example.invalid/join/proj_join#tok_join", { name: "jack", cwd });
    expect(scanRepo).toHaveBeenCalledWith(cwd, expect.any(ApiClient), null);
  });

  it("still completes join when the scan rejects", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(scanRepo).mockRejectedValue(new Error("boom"));
    const cwd = mkdtempSync(join(tmpdir(), "kp-join-scanfail-"));
    await expect(joinCommand("https://example.invalid/join/proj_join#tok_join", { name: "jack", cwd })).resolves.toBeUndefined();
  });
});
