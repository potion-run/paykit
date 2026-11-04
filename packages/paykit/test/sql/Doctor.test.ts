import { describe, expect, it } from "@alchemy.run/test";
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
      new Subscribe({ tier: "free", allowances: free }),
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
      log.append({
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
      const mismatches = doctor(log);
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
      const rebuilt = doctor(log)[0]!.rebuilt;
      log.upsertReadModel(rebuilt);
      expect(doctor(log)).toEqual([]);
    }),
  );

  it.effect("prints the event ids that disagree with a tampered read model", () =>
    Effect.gen(function* () {
      const { log } = yield* opened();
      const rebuilt = doctor(log)[0]!.rebuilt;
      log.upsertReadModel(rebuilt);
      log.upsertReadModel({ ...rebuilt, credits: 99 });
      const mismatches = doctor(log);
      expect(mismatches.length).toBe(1);
      expect(mismatches[0]?.stored?.credits).toBe(99);
      expect(mismatches[0]?.commandIds).toEqual(["evt_1"]);
    }),
  );

  it.effect("diffs every account independently", () =>
    Effect.gen(function* () {
      const { log } = yield* opened("acct_a");
      const b = yield* opened("acct_b");
      for (const row of b.log.events("Subscription", "acct_b")) {
        log.append({
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
      const first = doctor(log);
      log.upsertReadModel(first.find((mismatch) => mismatch.account === "acct_a")!.rebuilt);
      const mismatches = doctor(log);
      expect(mismatches.map((mismatch) => mismatch.account)).toEqual(["acct_b"]);
    }),
  );

  it.effect("ignores an unknown event tag but still reports the command id", () =>
    Effect.gen(function* () {
      const { log } = yield* opened();
      log.append({
        aggregate: "Subscription",
        account: "acct_doctor",
        commandId: "evt_unknown",
        at: at.epochMilliseconds + 1,
        events: [{ _tag: "SomethingThisVersionDoesNotKnow" }],
        state: {},
        receipt: {},
        deliveries: [],
      });
      const mismatches = doctor(log);
      expect(mismatches.length).toBe(1);
      expect(mismatches[0]?.rebuilt.tier).toBe("free");
      expect(mismatches[0]?.commandIds).toEqual(["evt_1", "evt_unknown"]);
    }),
  );

  it.effect("reports a read model row with no events as a mismatch", () =>
    Effect.gen(function* () {
      const { log } = yield* opened();
      const rebuilt = doctor(log)[0]!.rebuilt;
      log.upsertReadModel({ ...rebuilt, account: "acct_ghost" });
      const mismatches = doctor(log);
      expect(mismatches.map((mismatch) => mismatch.account)).toEqual(["acct_doctor", "acct_ghost"]);
      expect(mismatches.find((mismatch) => mismatch.account === "acct_ghost")?.stored).not.toBe(
        null,
      );
    }),
  );
});
