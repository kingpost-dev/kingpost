import { Project, SyntaxKind } from "ts-morph";

/**
 * Extracts every relative (`./`/`../`-prefixed) module specifier imported, re-exported, or
 * dynamically `import()`-ed in a TS/JS source file — the set of specifiers that COULD resolve
 * to a local file, as opposed to a bare package specifier (`"react"`, `"drizzle-orm/pg-core"`)
 * which never can. Used to detect when a file consumes a registered contract via a plain
 * relative import, without requiring the importing file to declare anything explicitly.
 *
 * Empirically consistent with parse-drizzle-schema.ts's ts-morph usage: `Project` and
 * `createSourceFile` don't throw on malformed input for this usage pattern (fresh Project per
 * call, one createSourceFile call) — garbled content just yields an AST with no matching import
 * nodes, so no try/catch is needed for the "unparseable → []" fallback.
 */
export function extractRelativeImports(content: string): string[] {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  const sourceFile = project.createSourceFile("source.ts", content);

  const specifiers: string[] = [];

  for (const imp of sourceFile.getImportDeclarations()) {
    specifiers.push(imp.getModuleSpecifierValue());
  }
  for (const exp of sourceFile.getExportDeclarations()) {
    const spec = exp.getModuleSpecifierValue();
    if (spec) specifiers.push(spec);
  }
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
    const arg = call.getArguments()[0];
    if (arg && arg.getKind() === SyntaxKind.StringLiteral) {
      specifiers.push(arg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText());
    }
  }

  return specifiers.filter((s) => s.startsWith("."));
}
