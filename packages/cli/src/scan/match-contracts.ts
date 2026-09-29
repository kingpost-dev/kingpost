import * as path from "node:path";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/** Strips a trailing source-file extension, if present, so "contracts/schema.ts" and
 * "contracts/schema" compare equal — imports are routinely written without an extension. */
function stripExtension(p: string): string {
  const ext = SOURCE_EXTENSIONS.find((e) => p.endsWith(e));
  return ext ? p.slice(0, -ext.length) : p;
}

/** Resolves each relative import specifier found in `importingFilePath` against that file's own
 * directory, returning forward-slash, project-relative paths (no `./`/`../` segments remaining).
 * Pure path math — does not touch the filesystem or know about registered contracts. */
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
