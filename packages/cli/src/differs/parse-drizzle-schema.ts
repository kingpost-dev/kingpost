import { Project, SyntaxKind, type CallExpression } from "ts-morph";

export interface DrizzleColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

export interface DrizzleTable {
  tableName: string;
  columns: DrizzleColumn[];
}

function unwrapChain(expr: CallExpression): { innermost: CallExpression; methodNames: string[] } {
  const methodNames: string[] = [];
  let current: CallExpression = expr;
  for (;;) {
    const callee = current.getExpression();
    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) break;
    const propAccess = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    methodNames.push(propAccess.getName());
    const inner = propAccess.getExpression();
    if (inner.getKind() !== SyntaxKind.CallExpression) break;
    current = inner.asKindOrThrow(SyntaxKind.CallExpression);
  }
  return { innermost: current, methodNames };
}

function parseColumn(expr: CallExpression): DrizzleColumn | null {
  const { innermost, methodNames } = unwrapChain(expr);
  const typeExpr = innermost.getExpression();
  if (typeExpr.getKind() !== SyntaxKind.Identifier) return null;
  const type = typeExpr.getText();

  const firstArg = innermost.getArguments()[0];
  if (!firstArg || firstArg.getKind() !== SyntaxKind.StringLiteral) return null;
  const name = firstArg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText();

  return {
    name,
    type,
    notNull: methodNames.includes("notNull"),
    primaryKey: methodNames.includes("primaryKey"),
  };
}

/**
 * Parses a Drizzle ORM schema file's source text and extracts table/column definitions.
 *
 * Handles the real Drizzle syntax used by kingpost-cloud's production schema: a
 * `pgTable(tableName, columnsObject, extraConfig?)` call where each column is a chained
 * builder expression, e.g. `text("col_name").notNull().primaryKey()`. Verified empirically
 * against kingpost-cloud's schema.ts, including `text`, `boolean`, `timestamp`, `bigserial`
 * (e.g. `bigserial("id", { mode: "number" }).primaryKey()`), `integer`, and `jsonb` columns.
 *
 * Only `pgTable` (Postgres) is recognized, not `mysqlTable`/`sqliteTable`. Only the column
 * builder's first string-literal argument (the column name) and its chained method names are
 * inspected; any options-object second argument (e.g. `{ mode: "number" }`, `{ withTimezone:
 * true }`) is intentionally ignored.
 *
 * Empirically verified: neither `new Project({ useInMemoryFileSystem: true, ... })` nor
 * `project.createSourceFile(...)` throws for this function's usage pattern (fresh `Project`
 * per call, single `createSourceFile` call). Garbled/invalid TypeScript just produces a
 * best-effort AST with zero matching `pgTable` calls, which is why returning an empty array
 * for unparseable content works without needing any try/catch here.
 */
export function parseDrizzleSchema(content: string): DrizzleTable[] {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  const sourceFile = project.createSourceFile("schema.ts", content);

  const tables: DrizzleTable[] = [];
  const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

  for (const call of calls) {
    const expr = call.getExpression();
    if (expr.getKind() !== SyntaxKind.Identifier || expr.getText() !== "pgTable") continue;

    const args = call.getArguments();
    const nameArg = args[0];
    const columnsArg = args[1];
    if (!nameArg || nameArg.getKind() !== SyntaxKind.StringLiteral) continue;
    if (!columnsArg || columnsArg.getKind() !== SyntaxKind.ObjectLiteralExpression) continue;

    const tableName = nameArg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText();
    const columnsObj = columnsArg.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
    const columns: DrizzleColumn[] = [];

    for (const prop of columnsObj.getProperties()) {
      if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
      const propAssignment = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
      const initializer = propAssignment.getInitializer();
      if (!initializer || initializer.getKind() !== SyntaxKind.CallExpression) continue;
      const column = parseColumn(initializer.asKindOrThrow(SyntaxKind.CallExpression));
      if (column) columns.push(column);
    }

    tables.push({ tableName, columns });
  }

  return tables;
}
