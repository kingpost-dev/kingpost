import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkSourceFiles } from "./walk-repo.js";

function touch(root: string, rel: string, content = "") {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe("walkSourceFiles", () => {
  it("returns project-relative, forward-slash paths of every .ts/.tsx/.js/.jsx file", () => {
    const root = mkdtempSync(join(tmpdir(), "kp-walk-"));
    touch(root, "index.ts");
    touch(root, "src/App.tsx");
    touch(root, "src/lib/util.js");
    touch(root, "src/lib/deep/Comp.jsx");
    touch(root, "README.md");
    touch(root, "src/data.json");

    expect(walkSourceFiles(root).sort()).toEqual(["index.ts", "src/App.tsx", "src/lib/deep/Comp.jsx", "src/lib/util.js"]);
  });

  it("skips node_modules, .git, dist, build, and any dot-prefixed directory or file", () => {
    const root = mkdtempSync(join(tmpdir(), "kp-walk-skip-"));
    touch(root, "src/keep.ts");
    touch(root, "node_modules/pkg/index.js");
    touch(root, "src/node_modules/nested/index.js");
    touch(root, ".git/hooks/x.js");
    touch(root, "dist/index.js");
    touch(root, "build/out.js");
    touch(root, ".next/server.js");
    touch(root, "src/.hidden.ts");

    expect(walkSourceFiles(root)).toEqual(["src/keep.ts"]);
  });

  it("returns an empty list for a nonexistent directory instead of throwing", () => {
    expect(walkSourceFiles(join(tmpdir(), "kp-walk-does-not-exist-" + Date.now()))).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("skips an unreadable subdirectory without throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "kp-walk-unreadable-"));
    touch(root, "src/keep.ts");
    touch(root, "locked/hidden.ts");
    chmodSync(join(root, "locked"), 0o000);
    try {
      expect(walkSourceFiles(root)).toEqual(["src/keep.ts"]);
    } finally {
      chmodSync(join(root, "locked"), 0o755);
    }
  });
});
