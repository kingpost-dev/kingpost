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

export function parseDrizzleSchema(content: string): DrizzleTable[] {
  let project: Project;
  try {
    project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  } catch {
    return [];
  }

  let sourceFile;
  try {
    sourceFile = project.createSourceFile("schema.ts", content);
  } catch {
    return [];
  }

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
