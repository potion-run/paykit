import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance } from "../../src/Allowance.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { doctor } from "../../src/Doctor.ts";
import { messages } from "../../src/Feature.ts";
import { migrate } from "../../src/Migrations/index.ts";
import { SqlEventLog } from "../../src/Store/SqlEventLog.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { initialSubscriptionState } from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";
import { Script, walk } from "../properties/Arbitraries.ts";
import { assertProperty } from "../support/Property.ts";
import { sqliteExecutor } from "../support/Sqlite.ts";

const freeTier = tier({
  id: "free",
  grants: [allowance(messages, { included: 100 })],
});
const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [freeTier] }));
const free = allowancesOf(testCatalog, "free")!;
const at = DateTime.makeUnsafe("2030-01-01T00:00:00Z");

const opened = (account = "acct_doctor") =>
  Effect.gen(function* () {
    const sql = sqliteExecutor();
    yield* migrate(sql);
    const log = SqlEventLog(sql, { now: () => 1_000 });
    const events = Subscription.definition.decide.Subscribe(
      initialSubscriptionState,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "free",
        allowances: free,
      }),
      {
        id: Subscription.ref(account).id,
        commandId: "evt_1",
        stream: `Subscription/${account}`,
        version: 0,
        now: at,
      },
    ) as ReadonlyArray<{ readonly _tag: string }>;
    for (const event of events) {
      const cls = Subscription.definition.events.find((candidate) => candidate.tag === event._tag)!;
      yield* log.append({
        aggregate: "Subscription",
        account,
        commandId: "evt_1",
        at: at.epochMilliseconds,
        events: [Schema.encodeUnknownSync(Schema.toCodecJson(cls as never) as never)(event)],
        state: {},
        receipt: {},
        deliveries: [],
      });
    }
    return { sql, log };
  });

describe("doctor", () => {
  it.effect("reports a missing read model and rebuilds the right row", () =>
    Effect.gen(function* () {
      const { log } = yield* opened();
      const mismatches = yield* doctor(log);
      expect(mismatches.length).toBe(1);
      expect(mismatches[0]?.account).toBe("acct_doctor");
      expect(mismatches[0]?.stored).toBe(null);
      expect(mismatches[0]?.rebuilt.tier).toBe("free");
      expect(mismatches[0]?.rebuilt.features.messages?.included).toBe(100);
      expect(mismatches[0]?.commandIds).toEqual(["evt_1"]);
    }),
  );

  it.effect("is clean when the read model matches the event log", () =>
    Effect.gen(function* () {
      const { log } = yield* opened();
      const rebuilt = (yield* doctor(log))[0]!.rebuilt;
      yield* log.upsertReadModel(rebuilt);
      expect(yield* doctor(log)).toEqual([]);
    }),
  );

  it.effect("prints the event ids that disagree with a tampered read model", () =>
    Effect.gen(function* () {
      const { log } = yield* opened();
      const rebuilt = (yield* doctor(log))[0]!.rebuilt;
      yield* log.upsertReadModel(rebuilt);
      yield* log.upsertReadModel({ ...rebuilt, credits: 99 });
      const mismatches = yield* doctor(log);
      expect(mismatches.length).toBe(1);
      expect(mismatches[0]?.stored?.credits).toBe(99);
      expect(mismatches[0]?.commandIds).toEqual(["evt_1"]);
    }),
  );

  it.effect("diffs every account independently", () =>
    Effect.gen(function* () {
      const { log } = yield* opened("acct_a");
      const b = yield* opened("acct_b");
      for (const row of yield* b.log.events("Subscription", "acct_b")) {
        yield* log.append({
          aggregate: row.aggregate,
          account: "acct_b",
          commandId: row.commandId,
          at: row.at,
          events: [JSON.parse(row.event)],
          state: {},
          receipt: {},
          deliveries: [],
        });
      }
      const first = yield* doctor(log);
      yield* log.upsertReadModel(first.find((mismatch) => mismatch.account === "acct_a")!.rebuilt);
      const mismatches = yield* doctor(log);
      expect(mismatches.map((mismatch) => mismatch.account)).toEqual(["acct_b"]);
    }),
  );

  it.effect("ignores an unknown event tag but still reports the command id", () =>
    Effect.gen(function* () {
      const { log } = yield* opened();
      yield* log.append({
        aggregate: "Subscription",
        account: "acct_doctor",
        commandId: "evt_unknown",
        at: at.epochMilliseconds + 1,
        events: [{ _tag: "SomethingThisVersionDoesNotKnow" }],
        state: {},
        receipt: {},
        deliveries: [],
      });
      const mismatches = yield* doctor(log);
      expect(mismatches.length).toBe(1);
      expect(mismatches[0]?.rebuilt.tier).toBe("free");
      expect(mismatches[0]?.commandIds).toEqual(["evt_1", "evt_unknown"]);
    }),
  );

  it.effect("fails on an event a known tag cannot decode, rather than skipping it", () =>
    Effect.gen(function* () {
      const { sql, log } = yield* opened();
      // A known tag with a payload the schema cannot read: a rename upstream,
      // or a hand-edited row. Skipping it would invent a mismatch.
      sql.run(`UPDATE billing_event SET event = ? WHERE account = ?`, [
        JSON.stringify({ _tag: "SubscriptionActivated" }),
        "acct_doctor",
      ]);
      const exit = yield* Effect.exit(doctor(log));
      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") return;
      // A decode failure is the doctor's typed failure, not a defect out of a sync decoder.
      expect(String(exit.cause)).toContain("SchemaError");
    }),
  );

  it.effect("rebuilds a clean row for any generated event history", () =>
    assertProperty(
      Arbitrary.schema(Script),
      (script) =>
        Effect.gen(function* () {
          const { events, now } = walk(script);
          if (events.length === 0) return true;

          const sql = sqliteExecutor();
          yield* migrate(sql);
          const log = SqlEventLog(sql, { now: () => now.epochMilliseconds });
          for (const [index, event] of events.entries()) {
            const cls = Subscription.definition.events.find(
              (candidate) => candidate.tag === event._tag,
            );
            if (cls === undefined) return false;
            yield* log.append({
              aggregate: "Subscription",
              account: "acct_doctor_gen",
              commandId: `gen-${index}`,
              at: now.epochMilliseconds,
              events: [Schema.encodeUnknownSync(Schema.toCodecJson(cls as never) as never)(event)],
              state: {},
              receipt: {},
              deliveries: [],
            });
          }

          // The rebuild is the reference: doctor reports the missing read
          // model, and once written it must agree with the log.
          const first = yield* doctor(log);
          if (first.length !== 1) return false;
          yield* log.upsertReadModel(first[0]!.rebuilt);
          const second = yield* doctor(log);
          return second.length === 0;
        }),
      { runs: 20, size: 40 },
    ),
  );

  it.effect("reports a read model row with no events as a mismatch", () =>
    Effect.gen(function* () {
      const { log } = yield* opened();
      const rebuilt = (yield* doctor(log))[0]!.rebuilt;
      yield* log.upsertReadModel({ ...rebuilt, account: "acct_ghost" });
      const mismatches = yield* doctor(log);
      expect(mismatches.map((mismatch) => mismatch.account)).toEqual(["acct_doctor", "acct_ghost"]);
      expect(mismatches.find((mismatch) => mismatch.account === "acct_ghost")?.stored).not.toBe(
        null,
      );
    }),
  );
});
