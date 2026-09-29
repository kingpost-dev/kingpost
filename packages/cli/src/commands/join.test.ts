import { describe, it, expect, vi, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { which } from "./join.js";

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
