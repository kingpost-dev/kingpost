import { describe, it, expect } from "vitest";
import { claimsOverlap, anyOverlap } from "./overlap.js";

describe("claimsOverlap", () => {
  it("matches identical paths", () => {
    expect(claimsOverlap("server/auth.ts", "server/auth.ts")).toBe(true);
  });
  it("matches a glob claim against a concrete file", () => {
    expect(claimsOverlap("server/auth/*", "server/auth/middleware.ts")).toBe(true);
  });
  it("matches two overlapping globs", () => {
    expect(claimsOverlap("server/auth/*", "server/auth/*")).toBe(true);
  });
  it("does not match unrelated paths", () => {
    expect(claimsOverlap("server/auth/*", "server/db/schema.ts")).toBe(false);
  });
});

describe("anyOverlap", () => {
  it("is true if any pair overlaps", () => {
    expect(anyOverlap(["server/auth/*"], ["ui/*", "server/auth/login.ts"])).toBe(true);
  });
  it("is false if no pair overlaps", () => {
    expect(anyOverlap(["server/auth/*"], ["ui/*"])).toBe(false);
  });
});
