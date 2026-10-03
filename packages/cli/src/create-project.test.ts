import { describe, it, expect, vi, afterEach } from "vitest";
import { createProject } from "./api.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createProject", () => {
  it("returns the projectId and token on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ projectId: "proj_1", token: "tok_1" }), { status: 201 })));
    await expect(createProject("https://example.invalid", "demo")).resolves.toEqual({ projectId: "proj_1", token: "tok_1" });
  });

  it("waits well past the 1.5s hook budget instead of aborting a slow first request", async () => {
    // Regression: a hardcoded 1500ms abort made `kingpost init` crash with a raw undici stack on
    // a cold/slow connection (observed: a normal init took 1.22s, right at the edge).
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            setTimeout(() => resolve(new Response(JSON.stringify({ projectId: "p", token: "t" }), { status: 201 })), 5000);
          })
      )
    );
    const result = createProject("https://example.invalid", "demo");
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toEqual({ projectId: "p", token: "t" });
  });

  it("still gives up eventually rather than hanging forever", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          })
      )
    );
    const result = createProject("https://example.invalid", "demo");
    const assertion = expect(result).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(15_001);
    await assertion;
  });

  it("throws a clear error on a non-2xx response instead of returning an undefined projectId", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })));
    await expect(createProject("https://example.invalid", "demo")).rejects.toThrow(/returned 500 while creating the project/);
  });
});
