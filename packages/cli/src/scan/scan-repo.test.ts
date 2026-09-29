import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo } from "./scan-repo.js";
import type { ApiClient } from "../api.js";

function touch(root: string, rel: string, content: string) {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function fakeClient(contracts: { id: string; path: string }[], declare = vi.fn().mockResolvedValue({ consumer: {} })) {
  const listContracts = vi.fn().mockResolvedValue({ contracts });
  return { client: { listContracts, declareConsumer: declare } as unknown as ApiClient, listContracts, declare };
}

describe("scanRepo", () => {
  it("declares every source file that imports a registered contract, with declared: false, and returns the count", async () => {
    const root = mkdtempSync(join(tmpdir(), "kp-scanrepo-"));
    touch(root, "src/a.ts", `import { X } from "../contracts/api";\n`);
    touch(root, "src/nested/b.tsx", `import { X } from "../../contracts/api";\nimport { Y } from "../../contracts/db";\n`);
    touch(root, "src/unrelated.ts", `import { z } from "zod";\nimport { h } from "./helpers";\n`);
    const { client, declare } = fakeClient([
      { id: "c_api", path: "contracts/api.ts" },
      { id: "c_db", path: "contracts/db.ts" },
    ]);

    const count = await scanRepo(root, client, "agent_1");

    expect(count).toBe(3);
    expect(declare).toHaveBeenCalledTimes(3);
    expect(declare).toHaveBeenCalledWith("c_api", { path: "src/a.ts", agentId: "agent_1", declared: false });
    expect(declare).toHaveBeenCalledWith("c_api", { path: "src/nested/b.tsx", agentId: "agent_1", declared: false });
    expect(declare).toHaveBeenCalledWith("c_db", { path: "src/nested/b.tsx", agentId: "agent_1", declared: false });
  });

  it("passes a null agentId through (init/join run before any agent is registered)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kp-scanrepo-null-"));
    touch(root, "src/a.ts", `import { X } from "../contracts/api";\n`);
    const { client, declare } = fakeClient([{ id: "c_api", path: "contracts/api.ts" }]);

    expect(await scanRepo(root, client, null)).toBe(1);
    expect(declare).toHaveBeenCalledWith("c_api", { path: "src/a.ts", agentId: null, declared: false });
  });

  it("skips files under contracts/ themselves", async () => {
    const root = mkdtempSync(join(tmpdir(), "kp-scanrepo-contracts-"));
    touch(root, "contracts/api.ts", `import { Y } from "./db";\n`);
    const { client, declare } = fakeClient([{ id: "c_db", path: "contracts/db.ts" }]);

    expect(await scanRepo(root, client, "agent_1")).toBe(0);
    expect(declare).not.toHaveBeenCalled();
  });

  it("fetches the contract list once, and returns 0 without declaring when nothing is registered", async () => {
    const root = mkdtempSync(join(tmpdir(), "kp-scanrepo-empty-"));
    touch(root, "src/a.ts", `import { X } from "../contracts/api";\n`);
    touch(root, "src/b.ts", `import { X } from "../contracts/api";\n`);
    const { client, listContracts, declare } = fakeClient([]);

    expect(await scanRepo(root, client, "agent_1")).toBe(0);
    expect(listContracts).toHaveBeenCalledTimes(1);
    expect(declare).not.toHaveBeenCalled();
  });

  it("issues declarations concurrently rather than one at a time", async () => {
    const root = mkdtempSync(join(tmpdir(), "kp-scanrepo-concurrent-"));
    touch(root, "src/a.ts", `import { X } from "../contracts/api";\n`);
    touch(root, "src/b.ts", `import { X } from "../contracts/api";\n`);
    let inFlight = 0;
    let maxInFlight = 0;
    const declare = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { consumer: {} };
    });
    const { client } = fakeClient([{ id: "c_api", path: "contracts/api.ts" }], declare);

    expect(await scanRepo(root, client, "agent_1")).toBe(2);
    expect(maxInFlight).toBe(2);
  });

  it("never throws: a listContracts failure returns 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "kp-scanrepo-listfail-"));
    touch(root, "src/a.ts", `import { X } from "../contracts/api";\n`);
    const client = { listContracts: vi.fn().mockRejectedValue(new Error("network")), declareConsumer: vi.fn() } as unknown as ApiClient;

    await expect(scanRepo(root, client, "agent_1")).resolves.toBe(0);
  });

  it("counts only declarations that succeeded when some fail", async () => {
    const root = mkdtempSync(join(tmpdir(), "kp-scanrepo-partial-"));
    touch(root, "src/a.ts", `import { X } from "../contracts/api";\n`);
    touch(root, "src/b.ts", `import { X } from "../contracts/api";\n`);
    const declare = vi.fn()
      .mockResolvedValueOnce({ consumer: {} })
      .mockRejectedValueOnce(new Error("500"));
    const { client } = fakeClient([{ id: "c_api", path: "contracts/api.ts" }], declare);

    await expect(scanRepo(root, client, "agent_1")).resolves.toBe(1);
  });
});
