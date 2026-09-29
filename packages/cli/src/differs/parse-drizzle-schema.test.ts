import { describe, it, expect } from "vitest";
import { parseDrizzleSchema } from "./parse-drizzle-schema.js";

// Copied verbatim from kingpost-cloud/packages/server/src/db/schema.ts's `consumers` table.
const CONSUMERS_TABLE = `
import { pgTable, text, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const consumers = pgTable(
  "consumers",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    contractId: text("contract_id").notNull(),
    path: text("path").notNull(),
    agentId: text("agent_id"),
    declared: boolean("declared").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byContract: index("consumers_contract_idx").on(t.contractId),
    byProjectContractPath: uniqueIndex("consumers_project_contract_path_idx").on(t.projectId, t.contractId, t.path),
  })
);
`;

describe("parseDrizzleSchema", () => {
  it("parses a real table definition with mixed column types and modifiers", () => {
    const tables = parseDrizzleSchema(CONSUMERS_TABLE);
    expect(tables).toHaveLength(1);
    expect(tables[0].tableName).toBe("consumers");

    const byName = Object.fromEntries(tables[0].columns.map((c) => [c.name, c]));
    expect(byName["id"]).toEqual({ name: "id", type: "text", notNull: false, primaryKey: true });
    expect(byName["project_id"]).toEqual({ name: "project_id", type: "text", notNull: true, primaryKey: false });
    expect(byName["agent_id"]).toEqual({ name: "agent_id", type: "text", notNull: false, primaryKey: false });
    expect(byName["declared"]).toEqual({ name: "declared", type: "boolean", notNull: true, primaryKey: false });
    expect(byName["created_at"]).toEqual({ name: "created_at", type: "timestamp", notNull: true, primaryKey: false });
  });

  it("returns an empty array for content with no pgTable calls", () => {
    expect(parseDrizzleSchema("export const foo = 1;")).toEqual([]);
  });

  it("returns an empty array for unparseable content", () => {
    expect(parseDrizzleSchema("this is not { valid typescript at all +++")).toEqual([]);
  });

  it("parses multiple tables in one file", () => {
    const twoTables = `
      import { pgTable, text } from "drizzle-orm/pg-core";
      export const a = pgTable("a", { id: text("id").primaryKey() });
      export const b = pgTable("b", { name: text("name").notNull() });
    `;
    const tables = parseDrizzleSchema(twoTables);
    expect(tables.map((t) => t.tableName).sort()).toEqual(["a", "b"]);
  });

  // Copied verbatim from kingpost-cloud/packages/server/src/db/schema.ts's `events` table.
  const EVENTS_TABLE = `
import { pgTable, text, bigserial, jsonb, timestamp, index } from "drizzle-orm/pg-core";

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectId: text("project_id").notNull(),
    agentId: text("agent_id"),
    userName: text("user_name"),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byProjectId: index("events_project_id_idx").on(t.projectId, t.id) })
);
`;

  it("parses bigserial, integer, and jsonb column types", () => {
    const tables = parseDrizzleSchema(EVENTS_TABLE);
    expect(tables).toHaveLength(1);
    expect(tables[0].tableName).toBe("events");

    const byName = Object.fromEntries(tables[0].columns.map((c) => [c.name, c]));
    expect(byName["id"]).toEqual({ name: "id", type: "bigserial", notNull: false, primaryKey: true });
    expect(byName["payload"]).toEqual({ name: "payload", type: "jsonb", notNull: true, primaryKey: false });
  });

  it("parses a plain integer column with a default", () => {
    const cursorColumn = `
      import { pgTable, integer } from "drizzle-orm/pg-core";
      export const agents = pgTable("agents", { cursor: integer("cursor").notNull().default(0) });
    `;
    const tables = parseDrizzleSchema(cursorColumn);
    expect(tables[0].columns[0]).toEqual({ name: "cursor", type: "integer", notNull: true, primaryKey: false });
  });

  it("ignores a multi-key options-object second argument on pgTable's column builder", () => {
    const optionsColumn = `
      import { pgTable, timestamp } from "drizzle-orm/pg-core";
      export const t = pgTable("t", {
        createdAt: timestamp("created_at", { withTimezone: true, mode: "date", precision: 3 }).notNull(),
      });
    `;
    const tables = parseDrizzleSchema(optionsColumn);
    expect(tables[0].columns[0]).toEqual({ name: "created_at", type: "timestamp", notNull: true, primaryKey: false });
  });

  it("parses a column definition with a comment in the middle of a multi-line chain", () => {
    const commentedColumn = `
      import { pgTable, text } from "drizzle-orm/pg-core";
      export const t = pgTable("t", {
        id: text("id")
          // primary key, matches kingpost-cloud's convention
          .primaryKey(),
      });
    `;
    const tables = parseDrizzleSchema(commentedColumn);
    expect(tables[0].columns[0]).toEqual({ name: "id", type: "text", notNull: false, primaryKey: true });
  });
});
