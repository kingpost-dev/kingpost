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

  it("summarizes breaking changes in plain words, without the validator's raw assertion text", () => {
    const withAge = JSON.stringify({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name"],
    });
    const removed = diffJsonSchema(withAge, base);
    expect(removed.summary).toBe("removes /properties/age");

    const required = diffJsonSchema(withAge, JSON.stringify({ ...JSON.parse(withAge), required: ["name", "age"] }));
    expect(required.summary).toBe('makes "age" required');

    const retyped = diffJsonSchema(
      withAge,
      JSON.stringify({ ...JSON.parse(withAge), properties: { name: { type: "string" }, age: { type: "string" } } })
    );
    expect(retyped.summary).toBe('changes /properties/age/type to "string"');

    for (const { summary } of [removed, required, retyped]) {
      expect(summary).not.toContain("!==");
      expect(summary).not.toContain("AssertionError");
    }
  });

  it("falls back to the first line of an unrecognised validator message", () => {
    // Guards the fallback path: never throw, never return the multi-line raw text.
    expect(diffJsonSchema(base, JSON.stringify({ type: "object", properties: {} })).summary).not.toContain("\n");
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
