import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { allowance, grant, type Allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import { Attach, AttachRequest, PreviewAttach, Update } from "../../src/Billing/Attach.binding.ts";
import { BillingApiLayer } from "../../src/Billing/BillingApi.layer.ts";
import { BillingInProcess } from "../../src/Billing/BillingInProcess.layer.ts";
import { BindingCall } from "../../src/Billing/Bindings.ts";
import { Check } from "../../src/Billing/Check.binding.ts";
import { BillingCommandsLive } from "../../src/Billing/Commands.rpc.ts";
import { BillingApi } from "../../src/BillingApi.api.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog, creditTermsOf } from "../../src/Catalog.ts";
import { CatalogGuardLive } from "../../src/CatalogGuard.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { feature, messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { ClosePeriod } from "../../src/Subscription/ClosePeriod.command.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import {
  allowancesOf,
  initialSubscriptionState,
  pendingPlanOf,
  planIdOf,
  planOfGroup,
  type AccountId,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";
import { completeCheckout, handleWebhook } from "../../src/Webhooks.ts";
import { evolveAt } from "../properties/Arbitraries.ts";

const seats = feature({ id: "seats", name: "Seats", kind: "non_consumable" });
const sso = feature({ id: "sso", name: "SSO", kind: "flag" });

/**
 * `bespoke` is a free custom plan, so its first activation is the model's own
 * command; `enterprise` is a priced custom plan, so its first activation goes
 * through a provider checkout carrying the quote (ADR 0042 §1). `free` is the
 * fixed plan a bespoke set must not be accepted on, and `rider` is a bespoke
 * add-on that stacks beside any base plan (ADR 0042 §2).
 */
const testCatalog = Effect.runSync(
  catalog({
    features: [messages, seats, sso],
    tiers: [
      tier({
        id: "free",
        credits: 100,
        grants: [allowance(messages, { included: 100 })],
      }),
      tier({
        id: "pro",
        price: { amount: 1_900, currency: "usd", interval: "month" },
        credits: 5_000,
        grants: [allowance(messages, { included: 2_000, overage: "bill" })],
      }),
      tier({
        id: "bespoke",
        custom: true,
        credits: 100,
        grants: [allowance(messages, { included: 100 })],
      }),
      tier({
        id: "enterprise",
        custom: true,
        price: { amount: 49_900, currency: "usd", interval: "month" },
        credits: 9_000,
        grants: [allowance(messages, { included: 10_000, overage: "bill" })],
      }),
      tier({
        id: "rider",
        custom: true,
        addOn: true,
        credits: 0,
        grants: [grant(sso)],
      }),
      // A group whose fallback is itself custom, and a non-default plan in that
      // group a customer can hold with bespoke terms. A cancellation re-grants
      // the floor's catalog terms, never the bespoke set (ADR 0043).
      tier({
        id: "team-floor",
        group: "team",
        isDefault: true,
        custom: true,
        price: { amount: 9_900, currency: "usd", interval: "month" },
        credits: 1_500,
        grants: [allowance(messages, { included: 5_000, overage: "bill" })],
      }),
      tier({
        id: "team-pro",
        group: "team",
        custom: true,
        credits: 4_000,
        grants: [allowance(messages, { included: 20_000, overage: "bill" })],
      }),
    ],
  }),
);

/** The negotiated items: none of them are in the plans' declared grants. */
const deal: ReadonlyArray<Allowance> = [
  allowance(messages, { included: 40_000, overage: "bill" }),
  grant(sso),
  allowance(seats, {
    included: 25,
    overage: "bill",
    unitPrice: { amount: 1_200, currency: "usd" },
  }),
];

const account = "acct_custom_plan" as AccountId;
const ref = Subscription.ref(account);
const asAccount = { headers: { "x-paykit-actor": ref.id } };

const Model = PaykitModel.layer(PaykitHandlers)
  .pipe(Layer.provideMerge(MemoryBillingReadStore))
  .pipe(Layer.provide(Domain.InMemory))
  .pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        InsecureDevGuards,
        CatalogGuardLive.pipe(Layer.provideMerge(catalogLayer(testCatalog))),
      ),
    ),
  );

const world = Layer.mergeAll(
  BillingInProcess,
  catalogLayer(testCatalog),
  PaymentsMemory().payments,
).pipe(Layer.provideMerge(Model));

const apiWorld = Layer.mergeAll(
  BillingApiLayer.pipe(Layer.provideMerge(BillingCommandsLive)),
  catalogLayer(testCatalog),
  PaymentsMemory().payments,
).pipe(
  Layer.provide(BillingApi.layerClientInProcess),
  Layer.provideMerge(Model),
  Layer.provide(Layer.succeed(BindingCall, asAccount)),
);

const stateOf = Effect.gen(function* () {
  const subscription = yield* Subscription;

  return yield* subscription.state(ref);
});

const planRowOf = Effect.gen(function* () {
  const state = yield* stateOf;

  if (state._tag !== "Subscribed") return null;

  return { planId: planIdOf(state), plans: state.plans, allowances: allowancesOf(state) };
});

/** The command payload a bespoke activation carries, built from the catalog. */
const bespokeInput = (grants: ReadonlyArray<Allowance>) => {
  const terms = creditTermsOf(testCatalog, "bespoke")!;
  const allowances: Record<string, Allowance> = {};

  for (const item of grants) allowances[item.feature] = item;

  return {
    tier: "bespoke",
    allowances,
    credits: terms.credits,
    creditsExpire: terms.creditsExpire,
    rates: terms.rates,
  };
};

describe("a custom plan", () => {
  it.live("attaches with allowances the catalog never declared for it", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      const result = yield* attach({
        planId: "bespoke",
        grants: deal,
        idempotencyKey: "custom-attach",
      });

      expect(result.outcome).toBe("activated");
      expect(result.planId).toBe("bespoke");

      const row = yield* planRowOf;
      expect(row?.planId).toBe("bespoke");
      expect(row?.plans.bespoke?.allowances.messages?.included).toBe(40_000);
      expect(row?.plans.bespoke?.allowances.sso?.kind).toBe("flag");
      expect(row?.plans.bespoke?.allowances.seats?.included).toBe(25);

      // The spend path answers from the event, not the catalog: the plan's own
      // `grants` say 100 (ADR 0041 §4).
      const check = yield* Check(account);
      const { balance } = yield* check({ featureId: "messages" });

      expect(balance.granted).toBe(40_000);
      expect(balance.remaining).toBe(40_000);

      const entitlements = yield* Entitlements;
      const view = Option.getOrNull(yield* entitlements.query(ref));

      expect(view?.features.messages?.included).toBe(40_000);
      expect(view?.features.sso?.kind).toBe("flag");
    }).pipe(Effect.provide(world)),
  );

  it.live("previews the deal it would record", () =>
    Effect.gen(function* () {
      const previewAttach = yield* PreviewAttach(account);

      const preview = yield* previewAttach({ planId: "bespoke", grants: deal });

      expect(preview.outcome).toBe("activated");
      expect(preview.preview?._tag).toBe("accepted");
      expect(
        preview.preview?._tag === "accepted"
          ? preview.preview.events.map((event) => event._tag)
          : [],
      ).toEqual(["SubscriptionActivated"]);
    }).pipe(Effect.provide(world)),
  );

  it.live("previews the quote a priced checkout would record", () =>
    Effect.gen(function* () {
      const previewAttach = yield* PreviewAttach(account);
      const price = { amount: 1_234_00, currency: "usd", interval: "annual" } as const;

      const preview = yield* previewAttach({ planId: "enterprise", grants: deal, price });

      expect(preview.outcome).toBe("checkout");
      expect(preview.preview?._tag).toBe("accepted");

      if (preview.preview?._tag !== "accepted") return;

      // The preview runs the same command and guard the completion will, so a
      // priced bespoke deal is shown rather than refused (ADR 0042 §1).
      expect(preview.preview.events.map((event) => event._tag)).toEqual(["SubscriptionActivated"]);
      expect(
        preview.preview.state._tag === "Subscribed"
          ? preview.preview.state.plans.enterprise?.allowances.messages?.included
          : undefined,
      ).toBe(40_000);
      expect(
        preview.preview.state._tag === "Subscribed"
          ? preview.preview.state.plans.enterprise?.price?.amount
          : undefined,
      ).toBe(price.amount);
    }).pipe(Effect.provide(world)),
  );

  it("refuses a bespoke item that does not decode at the request boundary", () => {
    // An item that is not an `Allowance` is a schema failure, not a refusal: no
    // command is ever built, so there is nothing for the guard to judge
    // (ADR 0041 §7).
    const decoded = Schema.decodeResult(AttachRequest)({
      planId: "bespoke",
      idempotencyKey: "custom-schema",
      grants: [{ feature: "messages", included: -1, overage: "allow", resets: "month" }],
    });

    expect(Result.isFailure(decoded)).toBe(true);
  });

  it.live("refuses an item for a feature the catalog never declared", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      const refused = yield* attach({
        planId: "bespoke",
        grants: [{ ...allowance(messages, { included: 1 }), feature: "ghost" as never }],
        idempotencyKey: "custom-ghost",
      }).pipe(Effect.flip);

      expect(refused._tag).toBe("CatalogMismatch");
      expect(yield* planRowOf).toBe(null);
    }).pipe(Effect.provide(world)),
  );

  it.live("refuses a bespoke set on a plan that is not custom", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      const refused = yield* attach({
        planId: "free",
        grants: deal,
        idempotencyKey: "custom-fixed",
      }).pipe(Effect.flip);

      expect(refused._tag).toBe("CatalogMismatch");
      expect(yield* planRowOf).toBe(null);
    }).pipe(Effect.provide(world)),
  );

  it.live("carries the bespoke quote through a priced checkout", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      const started = yield* attach({
        planId: "enterprise",
        grants: deal,
        idempotencyKey: "custom-checkout",
      });

      expect(started.outcome).toBe("checkout");
      expect(started.paymentUrl).toContain("checkout");

      // The quote is stored with the provider reference, before a standing
      // exists: the webhook has nothing else to activate from (ADR 0042 §1).
      const pending = yield* stateOf;

      if (pending._tag !== "Unsubscribed") throw new Error("expected no standing yet");
      const quote = Object.values(pending.pendingActivations ?? {})[0];

      expect(quote?.tier).toBe("enterprise");
      expect(quote?.allowances.messages?.included).toBe(40_000);
      expect(quote?.allowances.seats?.included).toBe(25);

      const action = yield* completeCheckout({
        id: "evt_custom_checkout",
        provider: "memory",
        account,
        tier: "enterprise",
      });

      expect(action).toBe("activated");

      const row = yield* planRowOf;
      expect(row?.planId).toBe("enterprise");
      expect(row?.plans.enterprise?.allowances.messages?.included).toBe(40_000);
      expect(row?.plans.enterprise?.allowances.sso?.kind).toBe("flag");

      // The completion spent every quote: one account has one standing, so the
      // other concurrent checkouts are moot (ADR 0044 §1).
      const after = yield* stateOf;
      expect(after.pendingActivations).toBeUndefined();
    }).pipe(Effect.provide(world)),
  );

  it.live("refuses a custom completion with no quoted terms", () =>
    Effect.gen(function* () {
      const refused = yield* completeCheckout({
        id: "evt_custom_missing",
        provider: "memory",
        account,
        tier: "enterprise",
      }).pipe(Effect.flip);

      expect(refused._tag).toBe("PendingActivationMissing");
      expect(yield* planRowOf).toBe(null);
    }).pipe(Effect.provide(world)),
  );

  it.live("refuses a completion whose quote belongs to another plan", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      yield* attach({
        planId: "enterprise",
        grants: deal,
        idempotencyKey: "custom-stale",
      });

      const refused = yield* completeCheckout({
        id: "evt_custom_stale",
        provider: "memory",
        account,
        tier: "bespoke",
      }).pipe(Effect.flip);

      expect(refused._tag).toBe("PendingActivationStale");
      expect(yield* planRowOf).toBe(null);
    }).pipe(Effect.provide(world)),
  );

  it.live("records a negotiated price through the purchase path", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);
      // The catalog sells this plan in USD; the deal is negotiated in EUR, which
      // a negotiated price decides for itself (ADR 0042 §3).
      const price = { amount: 1_234_00, currency: "eur", interval: "annual" } as const;

      const started = yield* attach({
        planId: "enterprise",
        grants: deal,
        price,
        idempotencyKey: "custom-price",
      });

      // The vendor's checkout sells the catalog's price object; an invoice is
      // the purchase path that takes the amount the deal states (ADR 0042 §3).
      expect(started.outcome).toBe("invoiced");
      expect(started.invoiceId).toBeDefined();

      const pending = yield* stateOf;

      if (pending._tag !== "Unsubscribed") throw new Error("expected no standing yet");

      const quote = Object.values(pending.pendingActivations ?? {})[0];

      expect(quote?.price?.amount).toBe(price.amount);
      expect(pending.pendingActivations?.[started.invoiceId!]).toBeDefined();

      // The invoice id is the reference, so the completion names the purchase
      // it paid for rather than relying on there being only one quote.
      yield* handleWebhook({
        id: "evt_custom_price",
        provider: "memory",
        kind: "payment_succeeded",
        account,
        tier: "enterprise",
        reference: started.invoiceId,
        amount: price.amount,
        currency: price.currency,
      });

      const row = yield* planRowOf;
      expect(row?.plans.enterprise?.price?.amount).toBe(price.amount);
      expect(row?.plans.enterprise?.price?.currency).toBe("eur");
      expect(row?.plans.enterprise?.price?.interval).toBe("annual");
      expect(row?.plans.enterprise?.allowances.messages?.included).toBe(40_000);
    }).pipe(Effect.provide(world)),
  );

  it.live("refuses a negotiated price on a plan that is not custom", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      const refused = yield* attach({
        planId: "free",
        price: { amount: 1_00, currency: "usd", interval: "month" },
        idempotencyKey: "custom-fixed-price",
      }).pipe(Effect.flip);

      expect(refused._tag).toBe("CatalogMismatch");
      expect(yield* planRowOf).toBe(null);
    }).pipe(Effect.provide(world)),
  );
});

describe("a bespoke add-on", () => {
  it.live("stacks beside the base plan with the items the catalog never declared", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      yield* attach({ planId: "free", idempotencyKey: "addon-base" });

      const added = yield* attach({
        planId: "rider",
        grants: [
          allowance(seats, {
            included: 5,
            overage: "bill",
            unitPrice: { amount: 900, currency: "usd" },
          }),
        ],
        idempotencyKey: "addon-rider",
      });

      expect(added.outcome).toBe("changed");

      const row = yield* planRowOf;
      expect(row?.planId).toBe("free");
      expect(row?.plans.rider?.addOn).toBe(true);
      expect(row?.plans.rider?.allowances.seats?.included).toBe(5);
      // The base plan is untouched and both sources are spendable beside each
      // other; a per-plan breakdown is the read-model follow-up (ADR 0042 §2).
      expect(row?.plans.free?.allowances.messages?.included).toBe(100);
      expect(row?.allowances.messages?.included).toBe(100);
      expect(row?.allowances.seats?.included).toBe(5);
    }).pipe(Effect.provide(world)),
  );
});

describe("a custom plan change", () => {
  it.live("moves to a custom plan immediately and back to the catalog's terms", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      yield* attach({ planId: "free", idempotencyKey: "move-free" });

      const up = yield* attach({
        planId: "enterprise",
        grants: deal,
        idempotencyKey: "move-enterprise",
      });

      expect(up.outcome).toBe("changed");
      expect(up.proration?.due).toBeGreaterThan(0);

      const bespoke = yield* planRowOf;
      expect(bespoke?.planId).toBe("enterprise");
      expect(bespoke?.plans.enterprise?.allowances.messages?.included).toBe(40_000);
      expect(bespoke?.plans.enterprise?.price?.amount).toBe(49_900);

      // A move to a fixed plan records the catalog's grants, so the deal ends
      // where its event says it does.
      const down = yield* attach({
        planId: "free",
        planSchedule: "immediate",
        idempotencyKey: "move-back",
      });

      expect(down.outcome).toBe("changed");

      const back = yield* planRowOf;
      expect(back?.planId).toBe("free");
      expect(back?.allowances.messages?.included).toBe(100);
      expect(back?.allowances.sso).toBeUndefined();
      expect(back?.allowances.seats).toBeUndefined();
    }).pipe(Effect.provide(world)),
  );

  it.live("moves to a custom plan at a negotiated price", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      yield* attach({ planId: "free", idempotencyKey: "price-move-free" });

      const moved = yield* attach({
        planId: "enterprise",
        grants: deal,
        price: { amount: 1_234_00, currency: "usd", interval: "annual" },
        idempotencyKey: "price-move-enterprise",
      });

      expect(moved.outcome).toBe("changed");
      // The event carries the price the move was sold at, and the plan row
      // folds it back out of the log (ADR 0042 §3).
      expect(moved.proration?.due).toBeGreaterThan(0);

      const row = yield* planRowOf;
      expect(row?.plans.enterprise?.price?.amount).toBe(1_234_00);
      expect(row?.plans.enterprise?.price?.interval).toBe("annual");
      expect(row?.plans.enterprise?.allowances.messages?.included).toBe(40_000);

      // Renegotiating only the price on the same plan is a move, not a replay.
      const repriced = yield* attach({
        planId: "enterprise",
        grants: deal,
        price: { amount: 2_000_00, currency: "usd", interval: "annual" },
        planSchedule: "immediate",
        idempotencyKey: "price-move-repriced",
      });

      expect(repriced.outcome).toBe("changed");
      expect((yield* planRowOf)?.plans.enterprise?.price?.amount).toBe(2_000_00);
    }).pipe(Effect.provide(world)),
  );

  it.live("renegotiates the same custom plan as an ordinary move", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      yield* attach({ planId: "bespoke", grants: deal, idempotencyKey: "renegotiate-first" });

      const richer = [allowance(messages, { included: 60_000, overage: "bill" }), grant(sso)];

      // The same plan with a different bespoke set is a new deal, not a replay,
      // so it moves like any other: at the boundary by default (ADR 0041 §6).
      const scheduled = yield* attach({
        planId: "bespoke",
        grants: richer,
        idempotencyKey: "renegotiate-boundary",
      });

      expect(scheduled.outcome).toBe("scheduled");

      const state = yield* stateOf;

      if (state._tag !== "Subscribed") throw new Error("expected a subscribed standing");

      expect(pendingPlanOf(state)?.allowances.messages?.included).toBe(60_000);

      const now = yield* attach({
        planId: "bespoke",
        grants: richer,
        planSchedule: "immediate",
        idempotencyKey: "renegotiate-now",
      });

      expect(now.outcome).toBe("changed");

      const after = yield* planRowOf;
      expect(after?.plans.bespoke?.allowances.messages?.included).toBe(60_000);
      expect(after?.plans.bespoke?.allowances.seats).toBeUndefined();
    }).pipe(Effect.provide(world)),
  );

  it.live("freezes the bespoke terms on a scheduled phase", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      yield* attach({ planId: "free", idempotencyKey: "phase-free" });
      yield* attach({ planId: "enterprise", grants: deal, idempotencyKey: "phase-enterprise" });

      const scheduled = yield* attach({
        planId: "bespoke",
        grants: deal,
        idempotencyKey: "phase-bespoke",
      });

      expect(scheduled.outcome).toBe("scheduled");

      const state = yield* stateOf;

      if (state._tag !== "Subscribed") throw new Error("expected a subscribed standing");

      // The phase carries the terms, because the boundary is applied from the
      // log and never from the catalog (ADR 0039 §3, ADR 0041 §4).
      expect(pendingPlanOf(state)?.planId).toBe("bespoke");
      expect(pendingPlanOf(state)?.allowances.messages?.included).toBe(40_000);
      expect(pendingPlanOf(state)?.allowances.seats?.included).toBe(25);
    }).pipe(Effect.provide(world)),
  );
});

describe("a custom plan over the Api", () => {
  it.live("records the bespoke items a wire caller states, and the read model reports them", () =>
    Effect.gen(function* () {
      const api = yield* BillingApi.clientInProcess;

      const receipt = yield* api.Subscribe(ref.id, bespokeInput(deal), asAccount);
      const view = yield* api.BillingState.get(ref.id, { atLeast: receipt, ...asAccount });

      expect(view?.plans.bespoke?.allowances.messages?.included).toBe(40_000);
      expect(view?.plans.bespoke?.allowances.sso?.kind).toBe("flag");
    }).pipe(Effect.provide(apiWorld)),
  );

  it.live("refuses an undeclared feature at the guard", () =>
    Effect.gen(function* () {
      const api = yield* BillingApi.clientInProcess;

      const refused = yield* api
        .Subscribe(
          ref.id,
          bespokeInput([
            allowance(messages, { included: 1 }),
            { ...allowance(messages, { included: 1 }), feature: "ghost" as never },
          ]),
          asAccount,
        )
        .pipe(Effect.flip);

      expect(refused._tag).toBe("CatalogMismatch");
      expect(yield* stateOf).toEqual(initialSubscriptionState);
    }).pipe(Effect.provide(apiWorld)),
  );

  it.live("replays the account log back into the same bespoke plan", () =>
    Effect.gen(function* () {
      const api = yield* BillingApi.clientInProcess;

      const receipt = yield* api.Subscribe(ref.id, bespokeInput(deal), asAccount);

      const live = yield* stateOf;

      if (live._tag !== "Subscribed") throw new Error("expected a subscribed standing");

      // A stream read trails the write until something anchors it, exactly like
      // a view read; the receipt is that anchor.
      yield* api.AccountEvents.peek(ref.id, { atLeast: receipt, ...asAccount });
      const page = yield* api.AccountEvents.list(ref.id, asAccount);
      const now = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
      const events = page.entries.map((entry) => entry.event);

      const replayed = evolveAt(initialSubscriptionState, events, now, ref.id);

      if (replayed._tag !== "Subscribed") throw new Error("expected a rebuilt standing");

      // A catalog deploy cannot rewrite the deal, because the log is what
      // rebuilds it (ADR 0041 §4).
      expect(replayed.plans).toEqual(live.plans);
      expect(replayed.plans.bespoke?.allowances.messages?.included).toBe(40_000);
      expect(replayed.plans.bespoke?.allowances.sso?.kind).toBe("flag");
    }).pipe(Effect.provide(apiWorld)),
  );
});

const otherDeal: ReadonlyArray<Allowance> = [
  allowance(messages, { included: 60_000, overage: "bill" }),
  grant(sso),
];

describe("a custom plan as a group's fallback", () => {
  const context = Context.make(Actor, system("test"));

  it.live("re-grants the catalog's terms, not the bespoke set the customer held", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);
      const update = yield* Update(account);

      // The customer holds bespoke terms on a non-default plan in the group.
      const attached = yield* attach({
        planId: "team-pro",
        grants: deal,
        idempotencyKey: "fallback-start",
      });

      expect(attached.outcome).toBe("activated");

      const held = yield* stateOf;

      if (held._tag !== "Subscribed") throw new Error("expected a subscribed standing");

      expect(held.plans["team-pro"]?.allowances.messages?.included).toBe(40_000);

      yield* update({
        cancelAction: "cancel_end_of_cycle",
        cancelGroup: "team",
        idempotencyKey: "fallback-cancel",
      });

      // The cancellation freezes the fallback from the catalog: the floor's
      // grants, price and credits, not the deal the customer held (ADR 0043).
      const canceled = yield* stateOf;

      if (canceled._tag !== "Subscribed") throw new Error("expected a subscribed standing");

      const fallback = canceled.cancellations?.team?.fallback;

      expect(fallback?.planId).toBe("team-floor");
      expect(fallback?.allowances.messages?.included).toBe(5_000);
      expect(fallback?.allowances.seats).toBeUndefined();
      expect(fallback?.price?.amount).toBe(9_900);
      expect(fallback?.credits).toBe(1_500);

      // The boundary applies the frozen row; it needs no catalog and cannot
      // recover the bespoke set (ADR 0039 §5, ADR 0043).
      const at = canceled.period.end;

      const verdict = Subscription.predict(canceled, new ClosePeriod({ periodEnd: at }), {
        id: ref.id,
        now: at,
        context,
      });

      if (verdict._tag !== "Accepted") throw new Error("expected the boundary to land");

      const boundary = verdict.state as SubscribedState;
      const landed = planOfGroup(boundary, "team");

      expect(landed?.planId).toBe("team-floor");
      expect(landed?.allowances.messages?.included).toBe(5_000);
      expect(landed?.allowances.seats).toBeUndefined();
      expect(landed?.price?.amount).toBe(9_900);
      expect(landed?.credits).toBe(1_500);
    }).pipe(Effect.provide(world)),
  );
});

describe("a quote keyed by its purchase", () => {
  it.live("activates the quote the completion names, and clears every quote", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      const older = yield* attach({
        planId: "enterprise",
        grants: deal,
        idempotencyKey: "quote-older",
      });

      const newer = yield* attach({
        planId: "enterprise",
        grants: otherDeal,
        idempotencyKey: "quote-newer",
      });

      expect(older.outcome).toBe("checkout");
      expect(newer.outcome).toBe("checkout");

      const held = yield* stateOf;

      if (held._tag !== "Unsubscribed") throw new Error("expected no standing yet");

      const quotes = held.pendingActivations ?? {};

      expect(Object.keys(quotes)).toHaveLength(2);

      // The reference is the vendor's id, not the hosted URL.
      const stored = held.refs.memory?.checkout;
      expect(stored).toBeDefined();
      expect(stored?.startsWith("https://")).toBe(false);

      const olderReference = Object.entries(quotes).find(
        ([, quote]) => quote.allowances.messages?.included === 40_000,
      )?.[0];

      expect(olderReference).toBeDefined();

      // Completing the older purchase activates the older quote, even though a
      // newer checkout was opened after it (ADR 0044 §1).
      const action = yield* completeCheckout({
        id: "evt_quote_older",
        provider: "memory",
        account,
        tier: "enterprise",
        reference: olderReference,
      });

      expect(action).toBe("activated");

      const row = yield* planRowOf;
      expect(row?.plans.enterprise?.allowances.messages?.included).toBe(40_000);
      expect(row?.plans.enterprise?.allowances.sso?.kind).toBe("flag");

      const after = yield* stateOf;
      expect(after.pendingActivations).toBeUndefined();
    }).pipe(Effect.provide(world)),
  );

  it.live("refuses a custom completion that names a quote the account does not hold", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      yield* attach({
        planId: "enterprise",
        grants: deal,
        idempotencyKey: "quote-unknown",
      });

      const refused = yield* completeCheckout({
        id: "evt_quote_unknown",
        provider: "memory",
        account,
        tier: "enterprise",
        reference: "co_missing",
      }).pipe(Effect.flip);

      expect(refused._tag).toBe("PendingActivationMissing");
      expect(yield* planRowOf).toBe(null);
    }).pipe(Effect.provide(world)),
  );

  it.live("refuses a completion that names no quote while two are held", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      yield* attach({ planId: "enterprise", grants: deal, idempotencyKey: "ambiguous-older" });
      yield* attach({ planId: "enterprise", grants: otherDeal, idempotencyKey: "ambiguous-newer" });

      const refused = yield* completeCheckout({
        id: "evt_quote_ambiguous",
        provider: "memory",
        account,
        tier: "enterprise",
      }).pipe(Effect.flip);

      expect(refused._tag).toBe("PendingActivationAmbiguous");

      if (refused._tag === "PendingActivationAmbiguous") {
        expect(refused.references).toHaveLength(2);
      }

      expect(yield* planRowOf).toBe(null);
    }).pipe(Effect.provide(world)),
  );

  it.live("activates the one quote an older adapter can name without a reference", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      yield* attach({ planId: "enterprise", grants: deal, idempotencyKey: "quote-compat" });

      const action = yield* completeCheckout({
        id: "evt_quote_compat",
        provider: "memory",
        account,
        tier: "enterprise",
      });

      expect(action).toBe("activated");
      expect((yield* planRowOf)?.plans.enterprise?.allowances.messages?.included).toBe(40_000);
    }).pipe(Effect.provide(world)),
  );
});
