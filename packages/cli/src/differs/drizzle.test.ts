import { describe, it, expect } from "vitest";
import { diffDrizzle } from "./drizzle.js";

const base = `
  import { pgTable, text, boolean } from "drizzle-orm/pg-core";
  export const users = pgTable("users", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    active: boolean("active"),
  });
`;

describe("diffDrizzle", () => {
  it("flags a dropped column as breaking", () => {
    const next = base.replace('active: boolean("active"),\n', "");
    expect(diffDrizzle(base, next).breaking).toBe(true);
  });

  it("flags a dropped table as breaking", () => {
    const next = `import { pgTable, text } from "drizzle-orm/pg-core";\nexport const other = pgTable("other", { id: text("id").primaryKey() });`;
    expect(diffDrizzle(base, next).breaking).toBe(true);
  });

  it("flags a column type change as breaking", () => {
    const next = base.replace('name: text("name").notNull(),', 'name: boolean("name").notNull(),');
    expect(diffDrizzle(base, next).breaking).toBe(true);
  });

  it("flags a newly-added notNull as breaking", () => {
    const next = base.replace('active: boolean("active"),', 'active: boolean("active").notNull(),');
    expect(diffDrizzle(base, next).breaking).toBe(true);
  });

  it("does not flag a newly added column as breaking", () => {
    const next = base.replace(
      'active: boolean("active"),',
      'active: boolean("active"),\n    nickname: text("nickname"),'
    );
    expect(diffDrizzle(base, next).breaking).toBe(false);
  });

  it("does not flag a newly added table as breaking", () => {
    const next = base + `\nexport const extra = pgTable("extra", { id: text("id").primaryKey() });`;
    expect(diffDrizzle(base, next).breaking).toBe(false);
  });

  it("does not flag removing notNull (making a field optional) as breaking", () => {
    const next = base.replace('name: text("name").notNull(),', 'name: text("name"),');
    expect(diffDrizzle(base, next).breaking).toBe(false);
  });

  it("treats unparseable content as non-breaking", () => {
    const result = diffDrizzle(base, "not valid typescript +++");
    expect(result.breaking).toBe(false);
    expect(result.summary).toContain("unable to parse");
  });
});
