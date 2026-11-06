import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import type { SubscriptionState } from "../../src/Subscription/Subscription.state.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import {
  WEBHOOK_PHASES,
  WEBHOOK_TRANSITIONS,
  WebhookInvalid,
  WebhookKind,
  handleWebhook,
  type WebhookEvent,
} from "../../src/Webhooks.ts";

const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});
const packTier = tier({
  id: "credits_1k",
  kind: "one_off",
  price: { amount: 9_900, currency: "usd", interval: "month" },
  credits: 1_000,
  grants: [],
});
const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [proTier, packTier] }));
const pro = allowancesOf(testCatalog, "pro")!;
const account = "acct_hook";
const graceUntil = DateTime.makeUnsafe("2030-01-08T00:00:00Z");

const World = Layer.mergeAll(
  PaykitModel.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore))).pipe(
    Layer.provide(Domain.InMemory),
  ),
  catalogLayer(testCatalog),
);

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(World));

const event = (input: Partial<WebhookEvent> & Pick<WebhookEvent, "id" | "kind">): WebhookEvent =>
  ({
    provider: "stripe",
    account,
    ...input,
  }) as WebhookEvent;

const state = stateOf(account);

function stateOf(id: string) {
  return Effect.gen(function* () {
    const subscription = yield* Subscription;
    return yield* subscription.state(Subscription.ref(id));
  });
}

const billingOf = (value: SubscriptionState) =>
  value._tag === "Subscribed"
    ? {
        status: value.status,
        graceUntil: value.graceUntil,
        cancelAtPeriodEnd: value.cancelAtPeriodEnd,
        dunningAttempts: value.dunningAttempts,
      }
    : null;

describe("WEBHOOK_TRANSITIONS", () => {
  it("answers every event kind in every phase", () => {
    for (const kind of WebhookKind.literals) {
      for (const phase of WEBHOOK_PHASES) {
        expect(WEBHOOK_TRANSITIONS[kind][phase]).toBeDefined();
      }
    }
  });
});

describe("webhook edge", () => {
  it.effect("checkout_completed activates a standing from the catalog", () =>
    Effect.gen(function* () {
      const action = yield* handleWebhook(
        event({ id: "evt_1", kind: "checkout_completed", tier: "pro" }),
      );
      expect(action).toBe("activated");
      expect(yield* state).toMatchObject({ status: "active", tier: "pro" });
    }).pipe(run),
  );

  it.effect("a redelivered checkout is a replay, not a second activation", () =>
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      const first = yield* handleWebhook(
        event({ id: "evt_dup", kind: "checkout_completed", tier: "pro" }),
      );
      const before = yield* subscription.state(Subscription.ref(account));
      const second = yield* handleWebhook(
        event({ id: "evt_dup", kind: "checkout_completed", tier: "pro" }),
      );
      const after = yield* subscription.state(Subscription.ref(account));
      expect(first).toBe("activated");
      expect(second).toBe("ignored");
      expect(after).toEqual(before);
    }).pipe(run),
  );

  it.effect("a one-off payment buys credits without changing the standing or replaying twice", () =>
    Effect.gen(function* () {
      yield* handleWebhook(
        event({ id: "evt_pack_stand", kind: "checkout_completed", tier: "pro" }),
      );
      const action = yield* handleWebhook(
        event({
          id: "evt_pack",
          kind: "payment_succeeded",
          tier: "credits_1k",
          amount: 9_900,
          currency: "usd",
        }),
      );
      expect(action).toBe("purchased");
      expect(yield* state).toMatchObject({ _tag: "Subscribed", tier: "pro", credits: 1_000 });

      // A redelivery is the same command id, so it records nothing again.
      const redelivered = yield* handleWebhook(
        event({
          id: "evt_pack",
          kind: "payment_succeeded",
          tier: "credits_1k",
          amount: 9_900,
          currency: "usd",
        }),
      );
      expect(redelivered).toBe("purchased");
      expect(yield* state).toMatchObject({ _tag: "Subscribed", tier: "pro", credits: 1_000 });
    }).pipe(run),
  );

  it.effect("a one-off checkout does not activate a second standing", () =>
    Effect.gen(function* () {
      yield* handleWebhook(
        event({ id: "evt_pack_checkout_stand", kind: "checkout_completed", tier: "pro" }),
      );
      const action = yield* handleWebhook(
        event({ id: "evt_pack_checkout", kind: "checkout_completed", tier: "credits_1k" }),
      );
      expect(action).toBe("purchased");
      const current = yield* state;
      expect(current).toMatchObject({ _tag: "Subscribed", tier: "pro", credits: 1_000 });
    }).pipe(run),
  );

  it.effect("a failed payment enters grace once per provider event", () =>
    Effect.gen(function* () {
      const subscription = yield* Subscription;
      yield* handleWebhook(event({ id: "evt_checkout", kind: "checkout_completed", tier: "pro" }));
      yield* handleWebhook(
        event({ id: "evt_fail", kind: "payment_failed", reason: "card_declined", graceUntil }),
      );
      yield* handleWebhook(
        event({ id: "evt_fail", kind: "payment_failed", reason: "card_declined", graceUntil }),
      );
      const current = yield* subscription.state(Subscription.ref(account));
      expect(current._tag).toBe("Subscribed");
      if (current._tag === "Subscribed") {
        expect(current.status).toBe("grace");
        expect(current.dunningAttempts).toBe(1);
        expect(current.graceUntil).toEqual(graceUntil);
      }
    }).pipe(run),
  );

  it.effect("a payment in grace recovers the account", () =>
    Effect.gen(function* () {
      yield* handleWebhook(
        event({ id: "evt_checkout_2", kind: "checkout_completed", tier: "pro" }),
      );
      yield* handleWebhook(
        event({ id: "evt_fail_2", kind: "payment_failed", reason: "card_declined", graceUntil }),
      );
      const action = yield* handleWebhook(
        event({
          id: "evt_paid_2",
          kind: "payment_succeeded",
          amount: 1900,
          currency: "usd",
        }),
      );
      expect(action).toBe("recovered");
      expect(yield* state).toMatchObject({ status: "active" });
    }).pipe(run),
  );

  it.effect("a payment failure then a success settles on active", () =>
    Effect.gen(function* () {
      yield* handleWebhook(
        event({ id: "evt_checkout_3", kind: "checkout_completed", tier: "pro" }),
      );
      yield* handleWebhook(
        event({ id: "evt_fail_3", kind: "payment_failed", reason: "card_declined", graceUntil }),
      );
      yield* handleWebhook(
        event({
          id: "evt_paid_3",
          kind: "payment_succeeded",
          amount: 1900,
          currency: "usd",
        }),
      );
      expect(yield* state).toMatchObject({ status: "active" });
    }).pipe(run),
  );

  it.effect("a success while already active records nothing", () =>
    Effect.gen(function* () {
      yield* handleWebhook(
        event({ id: "evt_checkout_4", kind: "checkout_completed", tier: "pro" }),
      );
      const subscription = yield* Subscription;
      const before = yield* subscription.state(Subscription.ref(account));
      const action = yield* handleWebhook(
        event({
          id: "evt_paid_4",
          kind: "payment_succeeded",
          amount: 1900,
          currency: "usd",
        }),
      );
      expect(action).toBe("ignored");
      expect(yield* subscription.state(Subscription.ref(account))).toEqual(before);
    }).pipe(run),
  );

  it.effect("a checkout without a tier is a typed webhook error", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        handleWebhook(event({ id: "evt_missing", kind: "checkout_completed" })),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("WebhookInvalid");
      expect(new WebhookInvalid({ event: "evt_missing", field: "tier" })._tag).toBe(
        "WebhookInvalid",
      );
    }).pipe(run),
  );

  it.effect("a subscription_canceled webhook schedules cancellation once", () =>
    Effect.gen(function* () {
      yield* handleWebhook(
        event({ id: "evt_checkout_5", kind: "checkout_completed", tier: "pro" }),
      );
      expect(
        yield* handleWebhook(event({ id: "evt_cancel_5", kind: "subscription_canceled" })),
      ).toBe("canceled");
      expect(
        yield* handleWebhook(event({ id: "evt_cancel_5", kind: "subscription_canceled" })),
      ).toBe("canceled");
      expect(yield* state).toMatchObject({ cancelAtPeriodEnd: true });
    }).pipe(run),
  );

  it.effect("a checkout for a standing that already exists does not reset it", () =>
    Effect.gen(function* () {
      yield* handleWebhook(event({ id: "evt_reset_1", kind: "checkout_completed", tier: "pro" }));
      const subscription = yield* Subscription;
      const ref = Subscription.ref(account);
      const before = yield* subscription.state(ref);
      if (before._tag !== "Subscribed") throw new Error("the checkout did not activate");
      yield* subscription
        .send(ref, new TrackUsage({ feature: "messages", amount: 10 }), {
          commandId: "track-reset",
        })
        .pipe(Effect.provideService(Actor, system("test")));

      // A different provider id must not become a second activation.
      expect(
        yield* handleWebhook(event({ id: "evt_reset_2", kind: "checkout_completed", tier: "pro" })),
      ).toBe("ignored");
      const after = yield* subscription.state(ref);
      if (after._tag !== "Subscribed") throw new Error("the standing disappeared");
      expect(after.usage.messages).toBe(10);
      expect(DateTime.toEpochMillis(after.period.start)).toBe(
        DateTime.toEpochMillis(before.period.start),
      );
    }).pipe(run),
  );

  it.effect("a fact that arrives before its standing is ignored, not buffered", () =>
    Effect.gen(function* () {
      // The edge does not invent an order across facts. A failure or a
      // cancellation with no standing has nothing to apply to; the provider's
      // retry is the recovery.
      expect(
        yield* handleWebhook(
          event({
            id: "evt_early_fail",
            kind: "payment_failed",
            reason: "card_declined",
            graceUntil,
          }),
        ),
      ).toBe("ignored");
      expect(
        yield* handleWebhook(event({ id: "evt_early_cancel", kind: "subscription_canceled" })),
      ).toBe("ignored");
      expect((yield* state)._tag).toBe("Unsubscribed");

      expect(
        yield* handleWebhook(
          event({ id: "evt_early_checkout", kind: "checkout_completed", tier: "pro" }),
        ),
      ).toBe("activated");
      expect(yield* state).toMatchObject({
        status: "active",
        cancelAtPeriodEnd: false,
      });
    }).pipe(run),
  );

  it.effect("a failure and a cancellation commute once a standing exists", () =>
    Effect.gen(function* () {
      const other = "acct_hook_commute";
      // Failure then cancellation.
      yield* handleWebhook(
        event({ id: "evt_commute_checkout_a", kind: "checkout_completed", tier: "pro" }),
      );
      yield* handleWebhook(
        event({
          id: "evt_commute_fail_a",
          kind: "payment_failed",
          reason: "card_declined",
          graceUntil,
        }),
      );
      expect(
        yield* handleWebhook(event({ id: "evt_commute_cancel_a", kind: "subscription_canceled" })),
      ).toBe("canceled");

      // Cancellation then failure, on a second account in the same model.
      yield* handleWebhook(
        event({
          id: "evt_commute_checkout_b",
          kind: "checkout_completed",
          tier: "pro",
          account: other,
        }),
      );
      expect(
        yield* handleWebhook(
          event({ id: "evt_commute_cancel_b", kind: "subscription_canceled", account: other }),
        ),
      ).toBe("canceled");
      yield* handleWebhook(
        event({
          id: "evt_commute_fail_b",
          kind: "payment_failed",
          reason: "card_declined",
          graceUntil,
          account: other,
        }),
      );

      expect(billingOf(yield* state)).toEqual(billingOf(yield* stateOf(other)));
    }).pipe(run),
  );

  it("the pro tier the webhook activates is the catalog's", () => {
    expect(pro.messages.included).toBe(2000);
  });
});
