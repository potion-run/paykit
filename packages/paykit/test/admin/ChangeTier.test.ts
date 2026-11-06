import * as Domain from "@alchemy.run/domain";
import { expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AdminChangeTier, AdminChangeTierLive } from "../../src/Admin/ChangeTier.ts";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog, tierTermsOf } from "../../src/Catalog.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { sameProration, type Proration } from "../../src/Proration.ts";
import { ChangeTier } from "../../src/Subscription/ChangeTier.command.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";
import { planChangeTier } from "../../src/TierCommand.ts";
import {
  decideAt,
  isAccepted,
  Script,
  testCatalog as generatedCatalog,
  TierName,
  walk,
} from "../properties/Arbitraries.ts";
import { assertProperty } from "../support/Property.ts";

const freeTier = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });
const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2_000 })],
});
const scaleTier = tier({
  id: "scale",
  price: { amount: 9_900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 5_000 })],
});
const testCatalog = Effect.runSync(
  catalog({ features: [messages], tiers: [freeTier, proTier, scaleTier] }),
);
const proAllowances = allowancesOf(testCatalog, "pro")!;
const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const account = "acct_change";

const Base = Layer.mergeAll(
  PaykitModel.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)))
    .pipe(Layer.provide(Domain.InMemory))
    .pipe(Layer.provideMerge(MemoryBillingReadStore)),
  catalogLayer(testCatalog),
  Layer.succeed(Actor, system("test")),
);

const World = AdminChangeTierLive.pipe(Layer.provideMerge(Base));

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(World));

const subscribeToPro = Effect.gen(function* () {
  const subscription = yield* Subscription;
  yield* subscription.send(
    Subscription.ref(account),
    new Subscribe({
      tier: "pro",
      allowances: proAllowances,
      price: proPrice,
      credits: 0,
      creditsExpire: "period",
      rates: {},
    }),
  );
});

it.live("quotes a tier change without recording it", () =>
  Effect.gen(function* () {
    yield* subscribeToPro;
    const change = yield* AdminChangeTier;
    const quote = yield* change.change({ account, tier: "scale" });
    expect(quote._tag).toBe("quoted");
    if (quote._tag !== "quoted") return;
    expect(quote.proration?.due).toBe(8000);

    const subscription = yield* Subscription;
    const state = yield* subscription.state(Subscription.ref(account));
    expect(state._tag === "Subscribed" ? state.tier : "").toBe("pro");
  }).pipe(run),
);

it.live("applies only the proration the operator confirmed", () =>
  Effect.gen(function* () {
    yield* subscribeToPro;
    const change = yield* AdminChangeTier;
    const quote = yield* change.change({ account, tier: "scale" });
    expect(quote._tag).toBe("quoted");
    if (quote._tag !== "quoted") return;

    const applied = yield* change.change({
      account,
      tier: "scale",
      expected: quote.proration,
      commandId: "cmd_change",
    });
    expect(applied._tag).toBe("applied");
    if (applied._tag !== "applied") return;
    expect(applied.commandId).toBe("cmd_change");
    expect(applied.proration?.due).toBe(8000);

    const subscription = yield* Subscription;
    const state = yield* subscription.state(Subscription.ref(account));
    expect(state._tag === "Subscribed" ? state.tier : "").toBe("scale");
  }).pipe(run),
);

it.live("returns a requote instead of applying a different amount", () =>
  Effect.gen(function* () {
    yield* subscribeToPro;
    const change = yield* AdminChangeTier;
    const wrong = { currency: "usd", credit: 0, charge: 0, due: 0 };
    const answer = yield* change.change({
      account,
      tier: "scale",
      expected: wrong,
      commandId: "cmd_wrong",
    });
    expect(answer._tag).toBe("requote");
    if (answer._tag !== "requote") return;
    expect(answer.proration?.due).toBe(8000);

    const subscription = yield* Subscription;
    const state = yield* subscription.state(Subscription.ref(account));
    expect(state._tag === "Subscribed" ? state.tier : "").toBe("pro");
  }).pipe(run),
);

it.live("refuses a change with no standing, and a tier the catalog lacks", () =>
  Effect.gen(function* () {
    const change = yield* AdminChangeTier;
    const noStanding = yield* change.change({ account, tier: "scale" });
    expect(noStanding._tag).toBe("rejected");
    if (noStanding._tag === "rejected") {
      expect(noStanding.rejection._tag).toBe("NotSubscribed");
    }

    const unknown = yield* change.change({ account, tier: "enterprise" });
    expect(unknown._tag).toBe("rejected");
    if (unknown._tag === "rejected") {
      expect(unknown.rejection._tag).toBe("TierNotInCatalog");
    }
  }).pipe(run),
);

/**
 * The console quotes a tier change before an operator confirms it, and the
 * quote is applied as the command. Both sides compute the proration from the
 * same prices and the same period, so a plan must never be refused for
 * carrying one the model did not expect — that would be an operator confirming
 * one amount and the log recording another.
 *
 * The property is over the shared generated history: any standing, any instant,
 * any tier the generated catalog sells.
 */
it.effect("a quoted tier change is never refused for disagreeing with itself", () =>
  assertProperty(
    Arbitrary.schema(Schema.Struct({ script: Script, tier: TierName })),
    ({ script, tier }) => {
      const { state, now } = walk(script);
      const plan = planChangeTier(generatedCatalog, tier, state, now);
      if (plan === null) return false;

      const decision = decideAt(state, new ChangeTier(plan.input), now, "quote");
      if (!isAccepted(decision)) {
        // A quote can be refused for the standing, the currency or a ceiling,
        // but never for its own arithmetic.
        return decision._tag !== "ProrationMismatch";
      }
      const changed = decision.find((event) => event._tag === "TierChanged") as
        | { readonly proration?: Proration }
        | undefined;
      if (changed === undefined) return false;
      // And the log carries the money the operator was shown.
      return sameProration(plan.proration, changed.proration ?? null);
    },
    { runs: 120, size: 40 },
  ),
);

const eurPriced = (amount: number) => ({
  amount,
  currency: "usd",
  interval: "month" as const,
  additionalCurrencies: [{ currency: "eur", amount }],
});

const eurCatalog = Effect.runSync(
  catalog({
    features: [messages],
    tiers: [
      tier({
        id: "pro",
        price: eurPriced(1_900),
        grants: [allowance(messages, { included: 2_000 })],
      }),
      tier({
        id: "scale",
        price: eurPriced(9_900),
        grants: [allowance(messages, { included: 5_000 })],
      }),
    ],
  }),
);

const EurWorld = AdminChangeTierLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      PaykitModel.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)))
        .pipe(Layer.provide(Domain.InMemory))
        .pipe(Layer.provideMerge(MemoryBillingReadStore)),
      catalogLayer(eurCatalog),
      Layer.succeed(Actor, system("test")),
    ),
  ),
);

const runEur = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(EurWorld));

it.live("quotes in the currency the standing was sold in", () =>
  Effect.gen(function* () {
    const subscription = yield* Subscription;
    const terms = tierTermsOf(eurCatalog, "pro", "eur")!;
    yield* subscription.send(
      Subscription.ref("acct_eur_change"),
      new Subscribe({
        tier: "pro",
        allowances: terms.allowances,
        credits: terms.credits,
        creditsExpire: terms.creditsExpire,
        rates: terms.rates,
        price: terms.price,
      }),
    );

    const change = yield* AdminChangeTier;
    const quote = yield* change.change({ account: "acct_eur_change", tier: "scale" });
    expect(quote._tag).toBe("quoted");
    if (quote._tag !== "quoted") return;
    expect(quote.proration?.currency).toBe("eur");
    expect(quote.proration?.due).toBe(8_000);
  }).pipe(runEur),
);
