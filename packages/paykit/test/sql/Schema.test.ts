import { describe, expect, it } from "@alchemy.run/test";
// The billing DDL is a derived artifact: `BILLING_SCHEMA` is the description,
// `schemaStatementsOf` renders it, and the committed `0001_init.sql` files are
// what a deploy applies. These cases pin the three together, so a hand-edited
// migration, an unquoted identifier or an unqualified index name fails here
// instead of in a release.
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  migrationFiles,
  migrationFingerprint,
  schemaFingerprint,
} from "../../src/Migrations/index.ts";
import {
  BILLING_SCHEMA,
  indexesOf,
  schemaStatementsOf,
  tablesOf,
  type Column,
  type Index,
  type SchemaDefinition,
  type Table,
} from "../../src/Migrations/Schema.ts";
import type { SqlDialect } from "../../src/Store/Sql.ts";
import { BILLING_TABLES, quoteIdentifier, tableName } from "../../src/Store/Tables.ts";

interface Scope {
  readonly dialect: SqlDialect;
  readonly schema?: string;
}

const scopes: ReadonlyArray<Scope> = [
  { dialect: "sqlite" },
  { dialect: "postgres", schema: "billing" },
];

const repositoryRoot = new URL("../../../../", import.meta.url);

/** Read a committed file through the platform services, not `node:fs`. */
const readCommitted = (relative: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(repositoryRoot);

    return yield* fs.readFileString(path.join(root, relative));
  }).pipe(Effect.provide(NodeServices.layer));

/** What `scripts/schema.ts` writes for a scope. */
const committedOf = (scope: Scope): string =>
  migrationFiles(scope)
    .map((file) => file.sql)
    .join("\n") + "\n";

const prefixOf = (item: Table | Index, scope: Scope): string =>
  "on" in item
    ? `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(item.name)} ON ${tableName(item.on, scope)} (`
    : `CREATE TABLE IF NOT EXISTS ${tableName(item.name, scope)} (`;

const withColumn = (schema: SchemaDefinition, on: string, column: Column): SchemaDefinition => ({
  ...schema,
  items: schema.items.map((item) =>
    "on" in item || item.name !== on ? item : { ...item, columns: [...item.columns, column] },
  ),
});

describe("the billing schema description", () => {
  it.effect("renders the committed SQLite migration byte for byte", () =>
    Effect.gen(function* () {
      const committed = yield* readCommitted("examples/billing/migrations/0001_init.sql");

      expect(committedOf({ dialect: "sqlite" })).toBe(committed);
    }),
  );

  it.effect("renders the committed Postgres migration byte for byte", () =>
    Effect.gen(function* () {
      const committed = yield* readCommitted("examples/postgres/migrations/0001_init.sql");

      expect(committedOf({ dialect: "postgres", schema: "billing" })).toBe(committed);
    }),
  );

  it.effect("renders every table and index exactly once, in order", () =>
    Effect.gen(function* () {
      expect(tablesOf(BILLING_SCHEMA).length + indexesOf(BILLING_SCHEMA).length).toBe(
        BILLING_SCHEMA.items.length,
      );
      expect(new Set(BILLING_SCHEMA.items.map((item) => item.name)).size).toBe(
        BILLING_SCHEMA.items.length,
      );

      for (const scope of scopes) {
        const statements = schemaStatementsOf(BILLING_SCHEMA, scope);

        expect(statements.length).toBe(BILLING_SCHEMA.items.length);
        expect(new Set(statements).size).toBe(statements.length);
        expect(migrationFiles(scope)[0]!.statements).toEqual(statements);

        BILLING_SCHEMA.items.forEach((item, position) => {
          const statement = statements[position]!;
          const prefix = prefixOf(item, scope);

          expect(statement.startsWith(prefix)).toBe(true);
          expect(statements.filter((other) => other.startsWith(prefix)).length).toBe(1);

          if ("on" in item) {
            for (const column of item.columns) {
              expect(statement).toContain(quoteIdentifier(column));
            }
          } else {
            for (const column of item.columns) {
              expect(statement).toContain(quoteIdentifier(column.name));
            }
          }
        });
      }
    }),
  );

  it.effect("quotes every identifier and never schema-qualifies an index name", () =>
    Effect.gen(function* () {
      for (const scope of scopes) {
        const statements = schemaStatementsOf(BILLING_SCHEMA, scope);

        for (const statement of statements) {
          // Strip quoted identifiers: a table or index name left bare would
          // still carry the `billing_` prefix in what remains.
          expect(statement.replaceAll(/"[^"]*"/g, "").toLowerCase()).not.toContain("bill");
          expect(statement).toContain('"billing_');
        }

        for (const statement of statements.filter((entry) => entry.startsWith("CREATE INDEX"))) {
          const [head] = statement.split(" ON ");

          // `CREATE INDEX IF NOT EXISTS "billing".` is a Postgres syntax error:
          // the index lands in its table's schema, so its name stays bare.
          expect(head).not.toContain(".");
          expect(head).toContain('"billing_');
        }
      }
    }),
  );

  it.effect("fingerprints the schema deterministically, and a column moves it", () =>
    Effect.gen(function* () {
      const sqlite = yield* schemaFingerprint({ dialect: "sqlite" });

      expect(sqlite).toMatch(/^[0-9a-f]{64}$/);
      expect(yield* schemaFingerprint({ dialect: "sqlite" })).toBe(sqlite);

      // The dialect-specific types (`millis`, `serial`) are part of the hash.
      expect(yield* schemaFingerprint({ dialect: "postgres" })).not.toBe(sqlite);

      const added: Column = { name: "experiment", type: "text", notNull: true };
      const widened = withColumn(BILLING_SCHEMA, BILLING_TABLES.event, added);

      expect(yield* schemaFingerprint({ dialect: "sqlite" }, widened)).not.toBe(sqlite);
    }),
  );

  it.effect("fingerprints the shipped file set and the scope it was rendered for", () =>
    Effect.gen(function* () {
      const shipped = yield* migrationFingerprint();

      expect(shipped).toMatch(/^[0-9a-f]{64}$/);
      expect(yield* migrationFingerprint()).toBe(shipped);
      expect(yield* migrationFingerprint({ dialect: "postgres" })).not.toBe(shipped);
      expect(yield* migrationFingerprint({ schema: "paykit" })).not.toBe(shipped);
      expect(yield* migrationFingerprint({ table: "paykit_migrations" })).not.toBe(shipped);
    }),
  );
});
