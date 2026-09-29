import { validateSchemaCompatibility } from "json-schema-diff-validator";

/**
 * Compares two JSON Schema documents and reports whether the change from
 * `oldContent` to `newContent` is breaking.
 *
 * Empirically verified against json-schema-diff-validator@0.4.2: on a
 * backward-incompatible change (removed property, newly-required field,
 * narrowed enum, etc.) `validateSchemaCompatibility` throws an
 * AssertionError whose `message` contains a JSON-patch-style diff. On a
 * compatible change it returns `undefined` without throwing.
 */
export function diffJsonSchema(oldContent: string, newContent: string): { breaking: boolean; summary: string } {
  let oldSchema: unknown;
  let newSchema: unknown;
  try {
    oldSchema = JSON.parse(oldContent);
    newSchema = JSON.parse(newContent);
  } catch {
    return { breaking: false, summary: "unable to parse, treated as non-breaking" };
  }

  try {
    validateSchemaCompatibility(oldSchema, newSchema);
    return { breaking: false, summary: "no breaking changes detected" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { breaking: true, summary: message };
  }
}
