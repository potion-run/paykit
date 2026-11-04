import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitModel, PaykitHandlers } from "../../src/Paykit.model.ts";
import { RecordPaymentFailure } from "../../src/Subscription/RecordPaymentFailure.command.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";

const freeTier = tier({
  id: "free",
  grants: [allowance(messages, { included: 100 })],
});
const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [freeTier, proTier] }));

const free = allowancesOf(testCatalog, "free")!;
const pro = allowancesOf(testCatalog, "pro")!;
const price = { amount: 1900, currency: "usd", interval: "month" as const };

const World = PaykitModel.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore))).pipe(
  Layer.provide(Domain.InMemory),
);

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(World));

describe("idempotence", () => {
  it.effect("a command replayed with the same commandId records no second event", () =>
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const account = Subscription.ref("acct_idem");
      yield* subscription.send(account, new Subscribe({ tier: "free", allowances: free }), {
        commandId: "subscribe-1",
      });
      const first = yield* subscription.send(
        account,
        new TrackUsage({ feature: "messages", amount: 10, dedupeKey: "req-1" }),
        { commandId: "track-1" },
      );
      const second = yield* subscription.send(
        account,
        new TrackUsage({ feature: "messages", amount: 10, dedupeKey: "req-1" }),
        { commandId: "track-1" },
      );
      expect(second.version).toBe(first.version);
      const state = yield* subscription.state(account);
      expect(state._tag === "Subscribed" ? state.usage.messages : -1).toBe(10);
    }).pipe(run),
  );

  it.effect("a payment failure replayed by webhook id does not advance dunning", () =>
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const account = Subscription.ref("acct_idem_2");
      yield* subscription.send(account, new Subscribe({ tier: "pro", allowances: pro, price }), {
        commandId: "subscribe-2",
      });
      const graceUntil = DateTime.makeUnsafe("2030-01-08T00:00:00Z");
      const command = new RecordPaymentFailure({ reason: "card_declined", graceUntil });
      yield* subscription.send(account, command, { commandId: "evt_failed_1" });
      yield* subscription.send(account, command, { commandId: "evt_failed_1" });
      const state = yield* subscription.state(account);
      expect(state._tag === "Subscribed" ? state.dunningAttempts : -1).toBe(1);
    }).pipe(run),
  );

  it.effect("the same usage key with a different commandId still records once", () =>
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const account = Subscription.ref("acct_idem_3");
      yield* subscription.send(account, new Subscribe({ tier: "free", allowances: free }), {
        commandId: "subscribe-3",
      });
      const first = yield* subscription.send(
        account,
        new TrackUsage({ feature: "messages", amount: 7, dedupeKey: "req-7" }),
        { commandId: "track-7a" },
      );
      const second = yield* subscription.send(
        account,
        new TrackUsage({ feature: "messages", amount: 7, dedupeKey: "req-7" }),
        { commandId: "track-7b" },
      );
      expect(second.version).toBe(first.version);
      const state = yield* subscription.state(account);
      expect(state._tag === "Subscribed" ? state.usage.messages : -1).toBe(7);
    }).pipe(run),
  );
});
