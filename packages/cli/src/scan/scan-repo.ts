import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiClient } from "../api.js";
import { isContractPath } from "../hooks/handlers.js";
import { walkSourceFiles } from "./walk-repo.js";
import { findConsumedContractIds } from "./match-contracts.js";

/** Full-repo version of the per-file PostToolUse consumer scan: walks every source file (outside
 * contracts/), and declares (`declared: false`) each one as a consumer of any registered contract
 * it imports. `agentId` is null at `init`/`join` time, before any agent has registered. Returns
 * how many relationships were recorded. Never throws — a failed scan must never block setup or a
 * tool call. */
export async function scanRepo(cwd: string, client: ApiClient, agentId: string | null): Promise<number> {
  try {
    const { contracts } = await client.listContracts();
    if (contracts.length === 0) return 0;
    const getContracts = async () => contracts;

    const declarations = await Promise.all(
      walkSourceFiles(cwd)
        .filter((filePath) => !isContractPath(filePath))
        .map(async (filePath) => {
          try {
            const content = readFileSync(join(cwd, filePath), "utf8");
            const ids = await findConsumedContractIds(filePath, content, getContracts);
            return ids.map((id) => ({ id, filePath }));
          } catch {
            return [];
          }
        })
    );

    const results = await Promise.allSettled(
      declarations.flat().map(({ id, filePath }) => client.declareConsumer(id, { path: filePath, agentId, declared: false }))
    );
    return results.filter((r) => r.status === "fulfilled").length;
  } catch {
    return 0;
  }
}
