import { describe, expect, it } from "@alchemy.run/test";
import type { SqlExecutor } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { billingOnPostgres } from "../src/SqlBilling.ts";

const recording = () => {
  const statements: Array<string> = [];

  const record = (statement: string) => {
    statements.push(statement);
  };

  const executor: SqlExecutor = {
    dialect: "postgres",
    query: <A = Record<string, unknown>>(statement: string) =>
      Effect.sync(() => {
        record(statement);

        return [] as ReadonlyArray<A>;
      }),
    write: (statement: string) =>
      Effect.sync(() => {
        record(statement);
      }),
    batch: (batch: ReadonlyArray<string>) =>
      Effect.sync(() => {
        for (const statement of batch) record(statement);
      }),
    atomic: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    isolation: "serializable",
    run: (statement: string) => {
      record(statement);
    },
    exec: (statement: string) => {
      record(statement);
    },
    get: <A>(statement: string) => {
      record(statement);

      return undefined as A | undefined;
    },
    all: <A>(statement: string) => {
      record(statement);

      return [] as ReadonlyArray<A>;
    },
    transaction: <A>(f: () => A) => f(),
    lock: () => {},
  };

  return { executor, statements };
};

describe("the Drizzle example schema", () => {
  it.live("uses a non-default schema in the event log and the platform", () =>
    Effect.gen(function* () {
      const { executor, statements } = recording();
      const { log, world } = billingOnPostgres(executor, { schema: "paykit_test" });

      yield* log.events("Subscription", "acct_schema");

      expect(
        statements.some((statement) => statement.includes('"paykit_test"."billing_event"')),
      ).toBe(true);
      expect(statements.every((statement) => !statement.includes('"billing".'))).toBe(true);

      statements.length = 0;

      yield* Effect.scoped(Layer.build(world));

      expect(
        statements.some((statement) => statement.includes('"paykit_test"."billing_rm_backfill"')),
      ).toBe(true);
      expect(statements.every((statement) => !statement.includes('"billing".'))).toBe(true);
    }),
  );
});
