import { describe, it, expect } from "vitest";
import { extractRelativeImports } from "./extract-imports.js";

describe("extractRelativeImports", () => {
  it("detects a default/named import", () => {
    expect(extractRelativeImports('import { foo } from "../contracts/schema";')).toEqual(["../contracts/schema"]);
  });

  it("detects a type-only import", () => {
    expect(extractRelativeImports('import type { Foo } from "../contracts/schema";')).toEqual(["../contracts/schema"]);
  });

  it("detects a re-export", () => {
    expect(extractRelativeImports('export { foo } from "./local/schema";')).toEqual(["./local/schema"]);
  });

  it("detects a dynamic import", () => {
    expect(extractRelativeImports('const mod = await import("../contracts/schema");')).toEqual(["../contracts/schema"]);
  });

  it("ignores bare package specifiers", () => {
    expect(extractRelativeImports('import { pgTable } from "drizzle-orm/pg-core";\nimport React from "react";')).toEqual([]);
  });

  it("returns multiple specifiers from one file", () => {
    const content = `
      import { a } from "../contracts/a";
      import { b } from "./b";
      import { c } from "some-package";
    `;
    expect(extractRelativeImports(content).sort()).toEqual(["../contracts/a", "./b"]);
  });

  it("returns an empty array for unparseable content", () => {
    expect(extractRelativeImports("this is not { valid typescript +++")).toEqual([]);
  });

  it("returns an empty array for content with no imports", () => {
    expect(extractRelativeImports("export const x = 1;")).toEqual([]);
  });

  it("does not treat a regular function call with a string-literal argument as an import", () => {
    const content = `
      foo("../not-a-real-import");
      const mod = await import("./real-dynamic-import");
    `;
    expect(extractRelativeImports(content)).toEqual(["./real-dynamic-import"]);
  });
});
