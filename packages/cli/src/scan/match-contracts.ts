import * as path from "node:path";
import { extractRelativeImports } from "./extract-imports.js";

// Longest-first: ".d.ts" must be checked before ".ts", or a declaration file would only have its
// trailing ".ts" stripped (leaving a stray ".d" suffix) instead of the whole ".d.ts" extension.
// Despite the name, this isn't just "source file" extensions — it's every extension a
// REGISTERED CONTRACT can have, since this list's whole job is stripping a contract path's
// extension so it compares equal to an extensionless import. Contracts aren't exclusively .ts:
// JSON Schema (.json) and YAML-format OpenAPI (.yaml/.yml) contracts are both real, supported
// formats, and were silently never matched via a normal extensionless import before this fix —
// found via a real end-to-end dogfood run (see V1.1e plan Task 6), not a hypothetical.
// .mjs/.cjs are intentionally still out of scope — add by demand if a real case comes up.
const SOURCE_EXTENSIONS = [".d.ts", ".ts", ".tsx", ".js", ".jsx", ".json", ".yaml", ".yml"];

/** Strips a trailing source-file extension, if present, so "contracts/schema.ts" and
 * "contracts/schema" compare equal — imports are routinely written without an extension. */
function stripExtension(p: string): string {
  const ext = SOURCE_EXTENSIONS.find((e) => p.endsWith(e));
  return ext ? p.slice(0, -ext.length) : p;
}

/** Resolves each relative import specifier found in `importingFilePath` against that file's own
 * directory, returning forward-slash, project-relative paths (no `./`/`../` segments remaining).
 * Pure path math — does not touch the filesystem or know about registered contracts.
 *
 * Known limit: a specifier with more `../` segments than the importing file's actual depth
 * resolves to a path starting with `..` (escaping the notional project root) rather than being
 * clamped or rejected — e.g. a file at "src/a.ts" importing "../../outside" resolves to
 * "../outside". This is harmless downstream: findConsumedContracts simply won't match it against
 * any realistically-registered (non-`..`-prefixed) contract path, so it silently yields no match
 * rather than crashing or false-matching — but callers should not assume every returned path is
 * genuinely inside the project. */
export function resolveContractPaths(importingFilePath: string, specifiers: string[]): string[] {
  const dir = path.posix.dirname(importingFilePath);
  return specifiers.map((spec) => path.posix.normalize(path.posix.join(dir, spec)));
}

/** Given a file's resolved import paths and the full set of registered contract paths, returns
 * which registered contracts are consumed (extension-tolerant on both sides). */
export function findConsumedContracts(resolvedPaths: string[], contractPaths: string[]): string[] {
  const resolvedStripped = new Set(resolvedPaths.map(stripExtension));
  return contractPaths.filter((cp) => resolvedStripped.has(stripExtension(cp)));
}

/** The one extract → resolve → match sequence shared by the per-file PostToolUse scan and the
 * full-repo scan: given one file's path and content, returns the ids of the registered contracts
 * it consumes via relative imports. `getContracts` is only called if the file has at least one
 * relative import, so a per-file caller can skip the network lookup entirely for files that
 * can't possibly match.
 *
 * Lives here rather than in scan-repo.ts (where the full-repo scan itself lives) to avoid a
 * circular import: scan-repo.ts already imports isContractPath from hooks/handlers.ts, and
 * hooks/handlers.ts needs this function — putting this function in scan-repo.ts would create
 * handlers.ts -> scan-repo.ts -> handlers.ts. */
export async function findConsumedContractIds(
  filePath: string,
  content: string,
  getContracts: () => Promise<{ id: string; path: string }[]>
): Promise<string[]> {
  const specifiers = extractRelativeImports(content);
  if (specifiers.length === 0) return [];
  const contracts = await getContracts();
  const consumed = findConsumedContracts(resolveContractPaths(filePath, specifiers), contracts.map((c) => c.path));
  return contracts.filter((c) => consumed.includes(c.path)).map((c) => c.id);
}
