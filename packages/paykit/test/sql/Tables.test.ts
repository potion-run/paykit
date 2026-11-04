import { describe, expect, it } from "@alchemy.run/test";
import {
  BILLING_TABLES,
  isSchemaName,
  quoteIdentifier,
  tableName,
} from "../../src/Store/Tables.ts";

describe("billing table names", () => {
  it("prefixes every table and index with billing_", () => {
    for (const name of Object.values(BILLING_TABLES)) {
      expect(name.startsWith("billing_")).toBe(true);
    }
  });

  it("leaves SQLite unqualified even when a schema is configured", () => {
    expect(tableName(BILLING_TABLES.event, { dialect: "sqlite", schema: "billing" })).toBe(
      '"billing_event"',
    );
  });

  it("qualifies Postgres tables with the configured schema", () => {
    expect(tableName(BILLING_TABLES.event, { dialect: "postgres", schema: "billing" })).toBe(
      '"billing"."billing_event"',
    );
    expect(tableName("billing_event_command", { dialect: "postgres", schema: "app" })).toBe(
      '"app"."billing_event_command"',
    );
  });

  it("never touches public and refuses an identifier that is not a name", () => {
    expect(isSchemaName("billing")).toBe(true);
    expect(isSchemaName("billing_2026")).toBe(true);
    expect(isSchemaName("public")).toBe(false);
    expect(isSchemaName("Billing")).toBe(false);
    expect(isSchemaName("billing; DROP TABLE billing_event")).toBe(false);
    expect(isSchemaName("billing.event")).toBe(false);
    expect(isSchemaName("")).toBe(false);
  });

  it("escapes a quote in an identifier", () => {
    expect(quoteIdentifier('odd"name')).toBe('"odd""name"');
  });
});
