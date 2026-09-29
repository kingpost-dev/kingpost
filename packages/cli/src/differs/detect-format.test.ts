import { describe, it, expect } from "vitest";
import { detectFormat } from "./detect-format.js";

describe("detectFormat", () => {
  it("detects an OpenAPI document by its openapi key", () => {
    expect(detectFormat("contracts/api.json", JSON.stringify({ openapi: "3.0.0", info: {}, paths: {} }))).toBe("openapi");
  });
  it("detects a JSON Schema document by its $schema key", () => {
    expect(
      detectFormat("contracts/user.json", JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }))
    ).toBe("json-schema");
  });
  it("detects a bare JSON Schema without an explicit $schema key", () => {
    expect(detectFormat("contracts/user.json", JSON.stringify({ type: "object", properties: {} }))).toBe("json-schema");
  });
  it("returns unknown for non-JSON content", () => {
    expect(detectFormat("contracts/schema.ts", "export type Foo = { bar: string }")).toBe("unknown");
  });
  it("returns unknown for unrelated JSON", () => {
    expect(detectFormat("contracts/config.json", JSON.stringify({ foo: "bar" }))).toBe("unknown");
  });
});
