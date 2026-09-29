import { describe, it, expect } from "vitest";
import { renderBrief } from "./brief.js";

describe("renderBrief", () => {
  it("stays within 30 lines even with lots of input", () => {
    const brief = renderBrief({
      agents: Array.from({ length: 20 }, (_, i) => ({
        id: `a${i}`,
        projectId: "p1",
        userName: `user${i}`,
        harness: "claude" as const,
        cwd: "/repo",
        statusText: "working",
        claims: [],
        lastSeen: "2026-09-28T00:00:00.000Z",
        cursor: 0,
      })),
      contracts: [],
      openQuestions: [],
      recentFindings: [],
    });
    expect(brief.split("\n").length).toBeLessThanOrEqual(30);
  });

  it("states 0 teammates active explicitly rather than omitting the count", () => {
    const brief = renderBrief({ agents: [], contracts: [], openQuestions: [], recentFindings: [] });
    expect(brief).toContain("0 teammates active");
  });

  it("includes a teammate's status", () => {
    const brief = renderBrief({
      agents: [
        {
          id: "a1",
          projectId: "p1",
          userName: "sam",
          harness: "codex" as const,
          cwd: "/repo",
          statusText: "wiring auth",
          claims: ["server/auth/*"],
          lastSeen: "2026-09-28T00:00:00.000Z",
          cursor: 0,
        },
      ],
      contracts: [],
      openQuestions: [],
      recentFindings: [],
    });
    expect(brief).toContain("sam");
    expect(brief).toContain("wiring auth");
  });
});
