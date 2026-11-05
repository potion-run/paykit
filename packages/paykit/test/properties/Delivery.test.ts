import { Database } from "bun:sqlite";
import type { Delivery, ViewSnapshot } from "@alchemy.run/domain/Platform";
import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { migrate } from "../../src/Migrations/index.ts";
import { SqlViewStore } from "../../src/Store/SqlConsumers.ts";
import { assertProperty } from "../support/Property.ts";
import { sqliteExecutor } from "../support/Sqlite.ts";

const at = "2030-01-01T00:00:00.000Z";

const deliveryOf = (seq: number) =>
  ({
    target: { kind: "view", name: "Entitlements" },
    key: "acct_delivery",
    source: "Subscription/acct_delivery",
    seq,
    origin: "Subscription",
    tag: "UsageRecorded",
    at,
    event: { _tag: "UsageRecorded", feature: "messages", amount: 1 },
    envelope: { seq, at, commandId: `cmd-${seq}` },
  }) as never;

const Batch = Schema.Array(
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 6 }))),
).pipe(Schema.check(Schema.isMaxLength(12)));

describe("delivery dedupe", () => {
  it.effect("a duplicate in one batch is applied once, by (source, seq)", () =>
    assertProperty(
      Arbitrary.schema(Batch),
      (seqs) =>
        Effect.gen(function* () {
          const sql = sqliteExecutor(new Database(":memory:"));
          yield* migrate(sql);
          const view = yield* SqlViewStore(sql, { name: "Entitlements", now: () => 1 });
          const seen: Array<number> = [];
          const bound = view.bind({
            name: "Entitlements",
            generation: 1,
            targets: [],
            consumerSingleSource: () => false,
            deliver: () => Effect.void,
            apply: (_key: string, snapshot: ViewSnapshot, deliveries: ReadonlyArray<Delivery>) =>
              Effect.sync(() => {
                seen.push(...deliveries.map((delivery) => delivery.seq));
                return {
                  snapshot: {
                    ...snapshot,
                    version: snapshot.version + 1,
                    seq: snapshot.seq + deliveries.length,
                    state: { applied: deliveries.length },
                  },
                  changed: true,
                  entries: [],
                  downstream: [],
                };
              }),
          } as never);

          yield* bound.receive(
            "acct_delivery",
            seqs.map((seq) => deliveryOf(seq)),
          );

          // One `apply` per distinct delivery in the batch, and every duplicate
          // dropped before the view sees it. The second delivery of a seq must
          // not become a second event.
          const unique = new Set(seqs);
          if (seen.length !== unique.size) return false;
          return new Set(seen).size === unique.size;
        }),
      { runs: 40, size: 20 },
    ),
  );
});
