import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ContractFile {
  /** Project-relative, forward-slashed, like every other contract path ("contracts/api.json"). */
  path: string;
  content: string;
  sha256: string;
}

// A contract is a small schema file. These caps keep the check that runs after every shell command cheap even in a
// project that dumps something large under contracts/.
const MAX_FILES = 100;
const MAX_BYTES = 256 * 1024;

/** Every file under <cwd>/contracts, with its content hash. Never throws: a missing directory or an unreadable
 * file just yields fewer results, since this runs on the hook path and must never break a session. */
export function listContractFiles(cwd: string): ContractFile[] {
  const found: ContractFile[] = [];
  const walk = (rel: string) => {
    if (found.length >= MAX_FILES) return;
    let names: string[];
    try {
      names = readdirSync(join(cwd, rel)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (found.length >= MAX_FILES) return;
      const childRel = `${rel}/${name}`;
      try {
        const stat = statSync(join(cwd, childRel));
        if (stat.isDirectory()) {
          if (name !== "node_modules" && !name.startsWith(".")) walk(childRel);
        } else if (stat.isFile() && stat.size <= MAX_BYTES) {
          const content = readFileSync(join(cwd, childRel), "utf8");
          found.push({ path: childRel, content, sha256: createHash("sha256").update(content).digest("hex") });
        }
      } catch {
        // unreadable: skip it
      }
    }
  };
  walk("contracts");
  return found;
}
