import { describe, it, expect, vi, afterEach } from "vitest";
import * as os from "node:os";
import { join } from "node:path";
import { codexAppServerSocketPath } from "./codex-rpc.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

describe("codexAppServerSocketPath", () => {
  const originalCodexHome = process.env.CODEX_HOME;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  it("uses an explicit codexHome argument when passed", () => {
    expect(codexAppServerSocketPath("/custom/codex-home")).toBe(
      join("/custom/codex-home", "app-server-control", "app-server-control.sock")
    );
  });

  it("falls back to homedir()/.codex when CODEX_HOME is unset", () => {
    delete process.env.CODEX_HOME;
    vi.mocked(os.homedir).mockReturnValue("/home/jack");
    expect(codexAppServerSocketPath()).toBe(join("/home/jack", ".codex", "app-server-control", "app-server-control.sock"));
  });

  it("respects the CODEX_HOME env var override, matching doctor.ts's ~/.codex pattern elsewhere", () => {
    process.env.CODEX_HOME = "/custom/codex-home-from-env";
    expect(codexAppServerSocketPath()).toBe(
      join("/custom/codex-home-from-env", "app-server-control", "app-server-control.sock")
    );
  });
});
