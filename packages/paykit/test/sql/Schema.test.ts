// The billing DDL is derived: `BILLING_SCHEMA` is the description, the
// renderer turns it into statements, and the registry applies those statements
// under a content hash. Nothing is committed to disk any more, so the thing that
// must not move is the *baseline* — `BILLING_SCHEMA_V1` — and its rendered hash
// is pinned here. A change to the target schema goes through `BILLING_SCHEMA`
// and convergence; a change to the baseline would rewrite every applied history
// row, and this test fails first.
import { describe, expect, it } from "@alchemy.run/test";
import { sha256 } from "alchemy/Util/sha256";
import * as Effect from "effect/Effect";
import {
  migrationFiles,
  migrationFingerprint,
  schemaFingerprint,
} from "../../src/Migrations/index.ts";
import {
  BILLING_SCHEMA,
  BILLING_SCHEMA_V1,
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
  { dialect: "mysql" },
];

/** The dialects that quote with double quotes and schema-qualify a table. */
const quotedScopes = scopes.filter((scope) => scope.dialect !== "mysql");

/**
 * The first release, rendered and hashed. This is the replacement for a
 * committed `.sql` file: the registry keys applied history by these bytes, so a
 * change here is a rewritten history, and it fails in this test rather than on
 * a deploy.
 */
const baselineHashes: ReadonlyArray<readonly [SqlDialect, string]> = [
  ["sqlite", "f629c9465bee994a52ef1d841b92d406346f5f70bcb952d6360cccbb13315bec"],
  ["postgres", "5928d4790dde9b83ea8c5e309c877646803454e3135f11587a0973ac1441f3c5"],
  ["mysql", "9aa84d64355a35fee180b731cddf2b5a9da7eac9ebd14fdf4c2d177e28182cd5"],
];

const renderedOf = (schema: SchemaDefinition, scope: Scope): ReadonlyArray<string> =>
  schemaStatementsOf(schema, scope);

/** The SQL a shipped migration carries, exactly as the registry hashes it. */
const shippedSql = (scope: Scope): string =>
  migrationFiles(scope)
    .map((file) => file.sql)
    .join("\n") + "\n";

const prefixOf = (item: Table | Index, scope: Scope): string =>
  "on" in item
    ? `${scope.dialect === "mysql" ? "CREATE INDEX" : "CREATE INDEX IF NOT EXISTS"} ${quoteIdentifier(item.name, scope.dialect)} ON ${tableName(item.on, scope)} (`
    : `CREATE TABLE IF NOT EXISTS ${tableName(item.name, scope)} (`;

const withColumn = (schema: SchemaDefinition, on: string, column: Column): SchemaDefinition => ({
  ...schema,
  items: schema.items.map((item) =>
    "on" in item || item.name !== on ? item : { ...item, columns: [...item.columns, column] },
  ),
});

describe("the billing schema description", () => {
  it.effect("keeps the first release frozen, per dialect", () =>
    Effect.gen(function* () {
      for (const [dialect, expected] of baselineHashes) {
        const scope = dialect === "postgres" ? { dialect, schema: "billing" } : { dialect };

        expect(yield* sha256(shippedSql(scope))).toBe(expected);
      }
    }),
  );

  it.effect("renders the baseline as the shipped migration, on every dialect", () =>
    Effect.gen(function* () {
      for (const scope of scopes) {
        expect(migrationFiles(scope)[0]!.statements).toEqual(renderedOf(BILLING_SCHEMA_V1, scope));
      }
    }),
  );

  it.effect("starts the target schema at the baseline", () =>
    Effect.gen(function* () {
      // A change to this invariant is fine — convergence applies it — but it has
      // to be a deliberate edit of `BILLING_SCHEMA`, not an accidental one.
      for (const scope of scopes) {
        expect(renderedOf(BILLING_SCHEMA, scope)).toEqual(renderedOf(BILLING_SCHEMA_V1, scope));
      }
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
        const statements = renderedOf(BILLING_SCHEMA, scope);

        expect(statements.length).toBe(BILLING_SCHEMA.items.length);
        expect(new Set(statements).size).toBe(statements.length);

        BILLING_SCHEMA.items.forEach((item, position) => {
          const statement = statements[position]!;
          const prefix = prefixOf(item, scope);

          expect(statement.startsWith(prefix)).toBe(true);
          expect(statements.filter((other) => other.startsWith(prefix)).length).toBe(1);

          if ("on" in item) {
            for (const column of item.columns) {
              expect(statement).toContain(quoteIdentifier(column, scope.dialect));
            }
          } else {
            for (const column of item.columns) {
              expect(statement).toContain(quoteIdentifier(column.name, scope.dialect));
            }
          }
        });
      }
    }),
  );

  it.effect("quotes every identifier and never schema-qualifies an index name", () =>
    Effect.gen(function* () {
      for (const scope of quotedScopes) {
        const statements = renderedOf(BILLING_SCHEMA, scope);

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
      expect(yield* schemaFingerprint({ dialect: "mysql" })).not.toBe(sqlite);

      const added: Column = { name: "experiment", type: "text", notNull: true };
      const widened = withColumn(BILLING_SCHEMA, BILLING_TABLES.event, added);

      expect(yield* schemaFingerprint({ dialect: "sqlite" }, widened)).not.toBe(sqlite);
    }),
  );

  it.effect("fingerprints the shipped baseline and the scope it was rendered for", () =>
    Effect.gen(function* () {
      const shipped = yield* migrationFingerprint();

      expect(shipped).toMatch(/^[0-9a-f]{64}$/);
      expect(yield* migrationFingerprint()).toBe(shipped);
      expect(yield* migrationFingerprint({ dialect: "postgres" })).not.toBe(shipped);
      expect(yield* migrationFingerprint({ dialect: "mysql" })).not.toBe(shipped);
      expect(yield* migrationFingerprint({ schema: "paykit" })).not.toBe(shipped);
      expect(yield* migrationFingerprint({ table: "paykit_migrations" })).not.toBe(shipped);
    }),
  );
});
