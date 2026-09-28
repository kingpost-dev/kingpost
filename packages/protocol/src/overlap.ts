/** A claim like "server/auth/*" overlaps "server/auth/middleware.ts" and "server/auth/*".
 *  A claim with no "*" is treated as an exact-or-prefix-directory match. */
export function claimsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const aBase = a.endsWith("*") ? a.slice(0, -1) : a + "/";
  const bBase = b.endsWith("*") ? b.slice(0, -1) : b + "/";
  return b.startsWith(aBase) || a.startsWith(bBase);
}

export function anyOverlap(paths: string[], otherPaths: string[]): boolean {
  return paths.some((p) => otherPaths.some((op) => claimsOverlap(p, op)));
}
