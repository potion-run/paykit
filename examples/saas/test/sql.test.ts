import { Database } from "bun:sqlite";
import { describe, expect, it } from "@alchemy.run/test";
import {
  type D1Like,
  type D1Prepared,
  migrationFiles,
  Paykit,
  type SqlValue,
} from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import { answering } from "../src/Agent.ts";
import { conversations, pro } from "../src/catalog.ts";
import { billingOnSql } from "../src/SqlBilling.ts";
import { project, Workspace } from "../src/Workspace.ts";
import { account, activate } from "./support.ts";

/**
 * A prepared statement over `bun:sqlite`, carrying the SQL and the binds it
 * holds. `D1Prepared` declares the optional `sql`; the binds are the fake's own,
 * which is what `batch` replays.
 */
interface FakeStatement extends D1Prepared {
  readonly sql: string;
  readonly params: ReadonlyArray<SqlValue>;
  bind(...values: ReadonlyArray<SqlValue>): FakeStatement;
}

/** Whether a statement is this fake's, so `batch` can read back its binds. */
const isFake = (statement: D1Prepared): statement is FakeStatement => "params" in statement;

const statementOver = (
  database: Database,
  sql: string,
  params: ReadonlyArray<SqlValue>,
): FakeStatement => ({
  sql,
  params,
  all: <T = Record<string, unknown>>() =>
    Promise.resolve({ results: database.query<T, SqlValue[]>(sql).all(...params) }),
  bind: (...values) => statementOver(database, sql, values),
});

/**
 * A `D1Like` over a real SQLite database: the same shape a Worker's binding
 * has, so the wiring the Worker uses is what this test exercises.
 */
const d1Over = (database: Database): D1Like => ({
  prepare: (sql: string) => statementOver(database, sql, []),
  batch: async (statements) => {
    database.exec("BEGIN IMMEDIATE");

    try {
      for (const statement of statements) {
        if (!isFake(statement)) throw new Error("a statement this fake did not prepare");
        database.query(statement.sql).run(...statement.params);
      }

      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },
});

/**
 * The schema a deployment applies: the statements the renderer emits, in the
 * same order `Paykit.sync` applies them. Nothing is read from disk, so a test
 * and a release cannot disagree about the DDL.
 */
const migrated = () => {
  const database = new Database(":memory:");
  const [init] = migrationFiles({ dialect: "sqlite" });

  for (const statement of init!.statements) database.exec(statement);

  return database;
};

describe("the example on a SQL database", () => {
  it.live("a project, its grant and a metered turn are rows, not memory", () =>
    Effect.gen(function* () {
      const database = migrated();
      const { world } = billingOnSql(d1Over(database));

      yield* Effect.gen(function* () {
        yield* activate(pro);

        const workspace = yield* Workspace(account.id);
        const docs = yield* workspace.create(project("proj_docs"), "Docs");

        yield* workspace.grant(docs.id, 250, "grant-docs-1");

        const { answer } = yield* answering;

        const answered = yield* answer(account.id, {
          project: docs.id,
          model: "default",
          requestId: "sql-turn-1",
        });

        expect(answered.reply).toContain("sql-turn-1");

        // A project's total is its own grant plus the shared pool; the grant is
        // what the turn spent, because a scope spends what it owns first.
        expect(answered.remaining).toBe(2_249);
        expect(answered.credits).toBe(4_999);

        const check = yield* Paykit.Check(account.id);

        const forProject = yield* check({
          featureId: conversations.id,
          entityId: docs.id,
          requiredBalance: 1,
        });

        expect(forProject.allowed).toBe(true);

        const own = forProject.balance.breakdown.filter((row) => row.pooled !== true);
        const pooled = forProject.balance.breakdown.filter((row) => row.pooled === true);

        expect(own.map((row) => row.remaining)).toEqual([249]);
        expect(pooled.map((row) => row.remaining)).toEqual([2_000]);
      }).pipe(Effect.provide(world));

      // The truth and the read model are rows in the same database.
      const entity = database
        .query('SELECT state FROM "billing_rm_view_state" WHERE view = ? AND key = ?')
        .get("Entitlements", account.id) as { state: string } | null;

      const state = JSON.parse(entity!.state) as {
        entities: Record<string, { name?: string; features: Record<string, { used: number }> }>;
        features: Record<string, { remaining: number | null }>;
      };

      expect(state.entities.proj_docs?.name).toBe("Docs");
      // The entity's own usage is a row, and the pooled source is unmoved.
      expect(state.entities.proj_docs?.features.conversations?.used).toBe(1);
      expect(state.features.conversations?.remaining).toBe(2_000);
    }),
  );
});
