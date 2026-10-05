import { validateSchemaCompatibility } from "json-schema-diff-validator";

interface PatchOp {
  op: string;
  path: string;
  value?: unknown;
}

/** Turns one JSON-patch op from the validator into a plain sentence. */
function describeOp({ op, path, value }: PatchOp): string {
  const required = path.match(/^(.*)\/required\/\d+$/);
  if (op === "add" && required) return `makes ${JSON.stringify(value)} required${required[1] ? ` at ${required[1]}` : ""}`;
  if (op === "remove") return `removes ${path}`;
  if (op === "replace") return `changes ${path} to ${JSON.stringify(value)}`;
  return `${op} ${path}${value === undefined ? "" : ` ${JSON.stringify(value)}`}`;
}

/** The validator's AssertionError message is "<sentence> breaking change = [<json patch>]\n\n1 !== 0".
 * Extracts the patch and describes it; falls back to the first line if the format ever changes. */
function summarizeValidatorMessage(message: string): string {
  const match = message.match(/breaking change = (\[.*\])/);
  if (match) {
    try {
      const ops = JSON.parse(match[1]) as PatchOp[];
      // The validator can report the same op more than once.
      const sentences = Array.from(new Set(ops.map(describeOp)));
      if (sentences.length > 0) return sentences.join("; ");
    } catch {
      // fall through to the raw first line
    }
  }
  return message.split("\n")[0];
}

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
    return { breaking: true, summary: summarizeValidatorMessage(message) };
  }
}
