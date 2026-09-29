import { readdirSync } from "node:fs";
import { join } from "node:path";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build"]);

/** Returns project-relative, forward-slash paths of every .ts/.tsx/.js/.jsx file under `cwd`,
 * skipping node_modules, dist, build, and anything dot-prefixed (.git, .next, ...). Unreadable
 * directories are skipped silently; symlinks are not followed (avoids cycles). */
export function walkSourceFiles(cwd: string): string[] {
  const results: string[] = [];

  function walk(relDir: string) {
    let entries;
    try {
      entries = readdirSync(join(cwd, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(relPath);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        results.push(relPath);
      }
    }
  }

  walk("");
  return results;
}
