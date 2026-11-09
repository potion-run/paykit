import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { allowance, grant, type Allowance } from "../../src/Allowance.ts";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import { Attach, AttachRequest, PreviewAttach } from "../../src/Billing/Attach.binding.ts";
import { BillingApiLayer } from "../../src/Billing/BillingApi.layer.ts";
import { BillingInProcess } from "../../src/Billing/BillingInProcess.layer.ts";
import { BindingCall } from "../../src/Billing/Bindings.ts";
import { Check } from "../../src/Billing/Check.binding.ts";
import { BillingApi } from "../../src/BillingApi.api.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog, creditTermsOf } from "../../src/Catalog.ts";
import { CatalogGuardLive } from "../../src/CatalogGuard.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { feature, messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import {
  allowancesOf,
  initialSubscriptionState,
  pendingPlanOf,
  planIdOf,
  type AccountId,
} from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";
import { evolveAt } from "../properties/Arbitraries.ts";

const seats = feature({ id: "seats", name: "Seats", kind: "non_consumable" });
const sso = feature({ id: "sso", name: "SSO", kind: "flag" });

/**
 * `bespoke` is a free custom plan, so its first activation is the model's own
 * command; `enterprise` is a priced custom plan, so its first activation would
 * be a provider checkout. `free` is the fixed plan a bespoke set must not be
 * accepted on (ADR 0041).
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
  BillingApiLayer,
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

  it.live("refuses a priced custom plan through a checkout", () =>
    Effect.gen(function* () {
      const attach = yield* Attach(account);

      const refused = yield* attach({
        planId: "enterprise",
        grants: deal,
        idempotencyKey: "custom-checkout",
      }).pipe(Effect.flip);

      expect(refused._tag).toBe("PlanOperationUnsupported");

      if (refused._tag === "PlanOperationUnsupported") {
        expect(refused.reason).toBe("custom_plan_checkout");
      }

      expect(yield* planRowOf).toBe(null);
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
