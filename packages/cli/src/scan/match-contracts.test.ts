import { describe, it, expect, vi } from "vitest";
import { resolveContractPaths, findConsumedContracts, findConsumedContractIds } from "./match-contracts.js";

describe("resolveContractPaths", () => {
  it("resolves a parent-directory relative import", () => {
    expect(resolveContractPaths("src/routes/users.ts", ["../contracts/schema"])).toEqual(["src/contracts/schema"]);
  });

  it("resolves a same-directory relative import", () => {
    expect(resolveContractPaths("src/routes/users.ts", ["./helpers"])).toEqual(["src/routes/helpers"]);
  });

  it("resolves a file at the project root", () => {
    expect(resolveContractPaths("index.ts", ["./contracts/schema"])).toEqual(["contracts/schema"]);
  });

  it("resolves multiple levels up", () => {
    expect(resolveContractPaths("src/a/b/c.ts", ["../../../contracts/schema"])).toEqual(["contracts/schema"]);
  });

  it("resolves a same-directory import from a single-segment-deep file", () => {
    expect(resolveContractPaths("src/index.ts", ["./contracts/schema"])).toEqual(["src/contracts/schema"]);
  });
});

describe("findConsumedContracts", () => {
  it("matches when both sides have no extension", () => {
    expect(findConsumedContracts(["contracts/schema"], ["contracts/schema"])).toEqual(["contracts/schema"]);
  });

  it("matches when the import has no extension but the registered path does", () => {
    expect(findConsumedContracts(["contracts/schema"], ["contracts/schema.ts"])).toEqual(["contracts/schema.ts"]);
  });

  it("matches when both sides have an extension", () => {
    expect(findConsumedContracts(["contracts/schema.ts"], ["contracts/schema.ts"])).toEqual(["contracts/schema.ts"]);
  });

  it("does not match an unrelated path", () => {
    expect(findConsumedContracts(["contracts/other"], ["contracts/schema.ts"])).toEqual([]);
  });

  it("returns multiple matches", () => {
    expect(findConsumedContracts(["contracts/a", "contracts/b"], ["contracts/a.ts", "contracts/b.ts", "contracts/c.ts"])).toEqual(["contracts/a.ts", "contracts/b.ts"]);
  });

  it("matches when the resolved import has an extension but the registered path does not", () => {
    expect(findConsumedContracts(["contracts/schema.ts"], ["contracts/schema"])).toEqual(["contracts/schema"]);
  });

  it("strips a .d.ts extension fully, not just its trailing .ts", () => {
    expect(findConsumedContracts(["contracts/types"], ["contracts/types.d.ts"])).toEqual(["contracts/types.d.ts"]);
  });
});

describe("findConsumedContractIds", () => {
  const contracts = [
    { id: "c_api", path: "contracts/api.ts" },
    { id: "c_db", path: "contracts/db.ts" },
  ];

  it("returns the ids of registered contracts a file's relative imports resolve to", async () => {
    const content = `import { X } from "../contracts/api";\nimport { h } from "./helpers";\n`;
    expect(await findConsumedContractIds("src/a.ts", content, async () => contracts)).toEqual(["c_api"]);
  });

  it("returns [] without ever fetching contracts when the file has no relative imports", async () => {
    const getContracts = vi.fn(async () => contracts);
    expect(await findConsumedContractIds("src/a.ts", `import { z } from "zod";\n`, getContracts)).toEqual([]);
    expect(getContracts).not.toHaveBeenCalled();
  });

  it("returns [] when no relative import matches a registered contract", async () => {
    expect(await findConsumedContractIds("src/a.ts", `import { h } from "./helpers";\n`, async () => contracts)).toEqual([]);
  });
});
