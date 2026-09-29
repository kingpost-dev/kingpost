import { describe, it, expect } from "vitest";
import { diffJsonSchema } from "./json-schema.js";

const base = JSON.stringify({ type: "object", properties: { name: { type: "string" } }, required: ["name"] });

describe("diffJsonSchema", () => {
  it("flags a newly-required field as breaking", () => {
    const next = JSON.stringify({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name", "age"],
    });
    expect(diffJsonSchema(base, next).breaking).toBe(true);
  });

  it("flags a removed property as breaking", () => {
    const next = JSON.stringify({ type: "object", properties: {}, required: [] });
    expect(diffJsonSchema(base, next).breaking).toBe(true);
  });

  it("flags a narrowed enum as breaking", () => {
    const withEnum = JSON.stringify({
      type: "object",
      properties: { status: { type: "string", enum: ["active", "inactive", "pending"] } },
    });
    const narrowed = JSON.stringify({
      type: "object",
      properties: { status: { type: "string", enum: ["active", "inactive"] } },
    });
    expect(diffJsonSchema(withEnum, narrowed).breaking).toBe(true);
  });

  it("does not flag an added optional property as breaking", () => {
    const next = JSON.stringify({
      type: "object",
      properties: { name: { type: "string" }, nickname: { type: "string" } },
      required: ["name"],
    });
    expect(diffJsonSchema(base, next).breaking).toBe(false);
  });

  it("treats unparseable content as non-breaking", () => {
    const result = diffJsonSchema(base, "{not valid json");
    expect(result.breaking).toBe(false);
    expect(result.summary).toContain("unable to parse");
  });
});
