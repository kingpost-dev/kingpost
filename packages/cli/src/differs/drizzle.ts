import { parseDrizzleSchema, type DrizzleTable } from "./parse-drizzle-schema.js";

/**
 * Compares two Drizzle ORM schema files and reports whether the change from
 * `oldContent` to `newContent` is breaking.
 *
 * This wraps `parseDrizzleSchema` (this package's own ts-morph-based parser, not a
 * third-party diffing library) and applies this differ's breaking-change rules by
 * comparing the two parsed table lists: a dropped table, a dropped column, a column's
 * `type` changing, and a column gaining `notNull: true` it didn't previously have are
 * all breaking. A newly added table/column and a column losing `notNull` (widening a
 * field from required to optional) are not breaking.
 *
 * If either side parses to zero tables (unparseable content, or a file with no
 * `pgTable` calls), this falls back to the same "unable to parse, treated as
 * non-breaking" convention used by the other differs in this directory.
 */
export function diffDrizzle(oldContent: string, newContent: string): { breaking: boolean; summary: string } {
  const oldTables = parseDrizzleSchema(oldContent);
  const newTables = parseDrizzleSchema(newContent);
  if (oldTables.length === 0 || newTables.length === 0) {
    return { breaking: false, summary: "unable to parse, treated as non-breaking" };
  }

  const newByName = new Map<string, DrizzleTable>(newTables.map((t) => [t.tableName, t]));
  const reasons: string[] = [];

  for (const oldTable of oldTables) {
    const newTable = newByName.get(oldTable.tableName);
    if (!newTable) {
      reasons.push(`table "${oldTable.tableName}" was dropped`);
      continue;
    }

    const newColByName = new Map(newTable.columns.map((c) => [c.name, c]));
    for (const oldCol of oldTable.columns) {
      const newCol = newColByName.get(oldCol.name);
      if (!newCol) {
        reasons.push(`column "${oldTable.tableName}.${oldCol.name}" was dropped`);
        continue;
      }
      if (newCol.type !== oldCol.type) {
        reasons.push(`column "${oldTable.tableName}.${oldCol.name}" changed type from ${oldCol.type} to ${newCol.type}`);
      }
      if (newCol.notNull && !oldCol.notNull) {
        reasons.push(`column "${oldTable.tableName}.${oldCol.name}" became not-null`);
      }
    }
  }

  if (reasons.length === 0) return { breaking: false, summary: "no breaking changes detected" };
  return { breaking: true, summary: reasons.join("; ") };
}
