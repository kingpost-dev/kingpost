import openapiDiff from "openapi-diff";

/**
 * Compares two OpenAPI/Swagger documents and reports whether the change from
 * `oldContent` to `newContent` is breaking.
 *
 * Note: `@azure/oad` (the other candidate from the plan) was empirically
 * ruled out — it shells out to a bundled .NET binary via `dotnet` (not
 * available in this environment or guaranteed in CI) and its programmatic
 * `compare()` entrypoint throws immediately (`Cannot read properties of
 * undefined (reading 'level')`) due to a winston version mismatch in its own
 * logging setup, before ever reaching the .NET step. `openapi-diff` is pure
 * JS and works out of the box, so it was used instead.
 *
 * Empirically verified against openapi-diff@0.24.1: `diffSpecs` is async and
 * resolves to `{ breakingDifferencesFound: boolean, breakingDifferences?,
 * nonBreakingDifferences, unclassifiedDifferences }` (no throw for
 * compatible/incompatible specs — breaking-ness is signaled purely via the
 * return value). It throws only when a spec can't be parsed/validated,
 * with `error.code === "OPENAPI_DIFF_PARSE_ERROR"`.
 *
 * Known limitation (empirically confirmed): openapi-diff does not diff
 * query/path/header *parameter* definitions at all (e.g. a query parameter
 * flipping from optional to required produces zero differences, not even
 * "unclassified") — its parameter support is limited to the request body
 * schema (compared via json-schema-diff) and response headers. A
 * newly-required *request body* field is correctly flagged as breaking; a
 * newly-required bare query/path parameter is not detected by this library.
 */
export async function diffOpenApi(oldContent: string, newContent: string): Promise<{ breaking: boolean; summary: string }> {
  let oldParsed: unknown;
  let newParsed: unknown;
  try {
    oldParsed = JSON.parse(oldContent);
    newParsed = JSON.parse(newContent);
  } catch {
    return { breaking: false, summary: "unable to parse, treated as non-breaking" };
  }

  const formatOf = (doc: unknown): "swagger2" | "openapi3" =>
    typeof doc === "object" && doc !== null && "swagger" in (doc as Record<string, unknown>) ? "swagger2" : "openapi3";

  try {
    const result = await openapiDiff.diffSpecs({
      sourceSpec: { content: oldContent, location: "old.json", format: formatOf(oldParsed) },
      destinationSpec: { content: newContent, location: "new.json", format: formatOf(newParsed) },
    });

    if (result.breakingDifferencesFound) {
      const codes = result.breakingDifferences.map((d) => d.code).join(", ");
      return { breaking: true, summary: `breaking changes detected: ${codes}` };
    }
    return { breaking: false, summary: "no breaking changes detected" };
  } catch (e) {
    // Expected to be OPENAPI_DIFF_PARSE_ERROR for genuinely malformed specs, but log whatever it
    // actually is — swallowing the message entirely would hide a real library bug behind an
    // identical-looking "nothing to worry about" result (matches watch.ts/resolved-path-hooks.ts's
    // established log-then-fall-back-gracefully pattern for non-critical failures).
    console.error(`kingpost: openapi-diff failed (${e instanceof Error ? e.message : String(e)}), treating as non-breaking`);
    return { breaking: false, summary: "unable to parse, treated as non-breaking" };
  }
}
