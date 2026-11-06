import { Story } from "@alchemy.run/domain/Story";
import { expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog, creditRatesOf, type Catalog } from "../../src/Catalog.ts";
import { feature, messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { Payments, paymentsRouter, type MoneyProvider } from "../../src/Payments.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { PaymentsStripe } from "../../src/PaymentsStripe.ts";
import {
  AutoTopUpInvalid,
  autoTopUp,
  topUpCommandId,
} from "../../src/Subscription/AutoTopUp.policy.ts";
import { BillingState } from "../../src/Subscription/BillingState.view.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import {
  CreditsPurchased,
  PurchaseCredits,
} from "../../src/Subscription/PurchaseCredits.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { TrackUsage, UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";

const ai = feature({ id: "ai", name: "AI", creditRates: { default: 1, "gpt-large": 10 } });
const price = { amount: 1_900, currency: "usd", interval: "month" as const };

const plan = tier({
  id: "plan",
  price,
  credits: 2_000,
  topUp: 1_000,
  grants: [allowance(messages, { included: 100 })],
});

// The same plan without a top-up line: the policy is installed, but this tier
// never asks it to buy.
const plain = tier({
  id: "plain",
  price,
  credits: 2_000,
  grants: [allowance(messages, { included: 100 })],
});

const pack = tier({
  id: "pack",
  kind: "one_off",
  price: { amount: 4_900, currency: "usd", interval: "month" },
  credits: 5_000,
  grants: [],
});

// A pack smaller than the threshold's headroom, so a refilled pool can fall
// back below the line without crossing it a second time.
const smallPack = tier({
  id: "pack_small",
  kind: "one_off",
  price: { amount: 990, currency: "usd", interval: "month" },
  credits: 100,
  grants: [],
});

const testCatalog = Effect.runSync(
  catalog({
    features: [messages, ai],
    tiers: [plan, plain, pack, smallPack],
  }),
);
const terms = allowancesOf(testCatalog, "plan")!;
const rates = creditRatesOf(testCatalog);
const account = Subscription.ref("acct_auto_top_up");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const start = at("2030-01-01T00:00:00Z");
const monthLater = at("2030-02-01T00:00:00Z");

const subscribed = [
  Story.provide(Actor, system("test")),
  Story.clock(start),
  Story.when(
    account,
    new Subscribe({
      tier: "plan",
      allowances: terms,
      price,
      credits: 2_000,
      creditsExpire: "period",
      topUp: 1_000,
      rates,
    }),
  ),
  Story.then(
    account,
    new SubscriptionActivated({
      tier: "plan",
      allowances: terms,
      remaining: { messages: 100 },
      credits: 2_000,
      creditsExpire: "period",
      topUp: 1_000,
      rates,
      periodStart: start,
      periodEnd: monthLater,
      anchorTz: "UTC",
      interval: "month",
      currency: "usd",
      price,
      statusAfter: "active",
    }),
  ),
] as const;

const plainTerms = allowancesOf(testCatalog, "plain")!;

const subscribedPlain = [
  Story.provide(Actor, system("test")),
  Story.clock(start),
  Story.when(
    account,
    new Subscribe({
      tier: "plain",
      allowances: plainTerms,
      price,
      credits: 2_000,
      creditsExpire: "period",
      rates,
    }),
  ),
  Story.then(
    account,
    new SubscriptionActivated({
      tier: "plain",
      allowances: plainTerms,
      remaining: { messages: 100 },
      credits: 2_000,
      creditsExpire: "period",
      rates,
      periodStart: start,
      periodEnd: monthLater,
      anchorTz: "UTC",
      interval: "month",
      currency: "usd",
      price,
      statusAfter: "active",
    }),
  ),
] as const;

const storyWith = (player: MoneyProvider, options: { readonly pack: string } | null) => {
  const handlers = PaykitHandlers.pipe(
    Layer.provide(MemoryBillingReadStore),
    Layer.provideMerge(paymentsRouter(player)),
  );
  return Story.make(PaykitModel, {
    layer:
      options === null
        ? handlers
        : handlers.pipe(
            Layer.provideMerge(
              autoTopUp({ catalog: testCatalog, pack: options.pack }).pipe(Layer.orDie),
            ),
          ),
  });
};

it.effect("buys the pack when a spend takes the pool across the threshold", () => {
  const commandId = topUpCommandId(account.id, 2);
  return storyWith(PaymentsMemory(), { pack: "pack" })(
    ...subscribed,
    // 2,000 credits spend down to 500: from above the threshold to below it.
    Story.when(account, new TrackUsage({ feature: "ai", amount: 1_500 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "ai",
        amount: 1_500,
        cost: 1_500,
        creditsAfter: 500,
        usedAfter: 1_500,
        remainingAfter: 500,
      }),
    ),
    // The policy asks the account's provider for the pack's price, keyed by
    // the crossing, then records the purchase with the invoice it opened.
    Story.call(Payments.createInvoice, {
      account: account.id,
      amount: 4_900,
      currency: "usd",
      commandId,
    }),
    Story.returned(Payments.createInvoice, { invoiceId: "in_1" }),
    Story.then(
      account,
      new CreditsPurchased({
        tier: "pack",
        amount: 5_000,
        price: pack.price!,
        rates,
        invoiceId: "in_1",
        balanceAfter: 5_500,
        prepaidAfter: 5_000,
      }),
    ),
    // The page carries the line the standing refills on, not just the pack.
    Story.view(BillingState, account, { topUp: 1_000 }),
    Story.view(Entitlements, account, { credits: 5_500 }),
  );
});

it.effect("buys once per crossing, not once per spend below the threshold", () => {
  const commandId = topUpCommandId(account.id, 2);
  return storyWith(PaymentsMemory(), { pack: "pack_small" })(
    ...subscribed,
    // 2,000 -> 900 crosses the line once.
    Story.when(account, new TrackUsage({ feature: "ai", amount: 1_100 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "ai",
        amount: 1_100,
        cost: 1_100,
        creditsAfter: 900,
        usedAfter: 1_100,
        remainingAfter: 900,
      }),
    ),
    Story.call(Payments.createInvoice, {
      account: account.id,
      amount: 990,
      currency: "usd",
      commandId,
    }),
    Story.returned(Payments.createInvoice, { invoiceId: "in_1" }),
    // The 100-credit pack lifts the pool exactly back to the line, so the
    // next spend is already below it: a spend is not a second crossing.
    Story.then(
      account,
      new CreditsPurchased({
        tier: "pack_small",
        amount: 100,
        price: smallPack.price!,
        rates,
        invoiceId: "in_1",
        balanceAfter: 1_000,
        prepaidAfter: 100,
      }),
    ),
    Story.when(account, new TrackUsage({ feature: "ai", amount: 100 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "ai",
        amount: 100,
        cost: 100,
        creditsAfter: 900,
        usedAfter: 1_200,
        remainingAfter: 900,
      }),
    ),
    Story.view(Entitlements, account, { credits: 900 }),
  );
});

it.effect("does nothing for a tier that states no top-up line", () =>
  // The policy is installed and the pack is valid, but this tier never asked
  // to refill: the line is the tier's, not the deployment's.
  storyWith(PaymentsMemory(), { pack: "pack" })(
    ...subscribedPlain,
    Story.when(account, new TrackUsage({ feature: "ai", amount: 1_500 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "ai",
        amount: 1_500,
        cost: 1_500,
        creditsAfter: 500,
        usedAfter: 1_500,
        remainingAfter: 500,
      }),
    ),
    Story.view(Entitlements, account, { credits: 500 }),
  ),
);

it.effect("does nothing for a pool with no standing to read a line from", () =>
  // A pack bought before any plan has a pool but no tier, so there is no line
  // for the policy to cross. The deployment-wide threshold used to cover this.
  storyWith(PaymentsMemory(), { pack: "pack" })(
    Story.provide(Actor, system("test")),
    Story.clock(start),
    Story.when(
      account,
      new PurchaseCredits({
        tier: "pack",
        amount: 5_000,
        price: pack.price!,
        rates,
      }),
    ),
    Story.then(
      account,
      new CreditsPurchased({
        tier: "pack",
        amount: 5_000,
        price: pack.price!,
        rates,
        balanceAfter: 5_000,
        prepaidAfter: 5_000,
      }),
    ),
    Story.when(account, new TrackUsage({ feature: "ai", amount: 4_600 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "ai",
        amount: 4_600,
        cost: 4_600,
        creditsAfter: 400,
        usedAfter: 4_600,
        remainingAfter: 400,
      }),
    ),
    Story.view(Entitlements, account, { credits: 400 }),
  ),
);

it.effect("does nothing when the deployment never opted in", () => {
  const story = storyWith(PaymentsMemory(), null);
  return story(
    ...subscribed,
    Story.when(account, new TrackUsage({ feature: "ai", amount: 1_500 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "ai",
        amount: 1_500,
        cost: 1_500,
        creditsAfter: 500,
        usedAfter: 1_500,
        remainingAfter: 500,
      }),
    ),
    Story.view(Entitlements, account, { credits: 500 }),
  );
});

it.effect("refuses to grant credits when the provider cannot open an invoice", () =>
  Effect.gen(function* () {
    // A processor configured only for checkout: no `invoice` capability, so
    // there is no money path for the pack and the policy must not grant it.
    const checkoutOnly = PaymentsStripe({
      bindings: {
        createCheckoutSession: () => Effect.succeed({ url: "https://checkout.test" }),
        createCustomerSession: () => Effect.succeed({ url: "https://portal.test" }),
      },
    });
    const story = storyWith(checkoutOnly, { pack: "pack" });
    // The failure is the policy's defect, not a story expectation: the pack is
    // never recorded, because the invoice that would price it cannot be opened.
    const reason = yield* story(
      ...subscribed,
      Story.when(account, new TrackUsage({ feature: "ai", amount: 1_500 })),
      Story.then(
        account,
        new UsageRecorded({
          feature: "ai",
          amount: 1_500,
          cost: 1_500,
          creditsAfter: 500,
          usedAfter: 1_500,
          remainingAfter: 500,
        }),
      ),
    ).pipe(
      Effect.match({
        onFailure: (failure) => failure.message,
        onSuccess: () => "settled",
      }),
    );
    expect(reason).toContain("ProviderCapabilityMissing");
  }),
);

/** A catalog value a hand-written config could pass, without the deploy's validation. */
const handBuilt = (tiers: ReadonlyArray<unknown>): Catalog =>
  ({ features: [], tiers }) as unknown as Catalog;

const refusal = (options: Parameters<typeof autoTopUp>[0]) =>
  Effect.provide(Effect.void, autoTopUp(options)).pipe(
    Effect.match({
      onFailure: (error) => error.reason as string,
      onSuccess: () => "accepted",
    }),
  );

it.effect("refuses a config the catalog cannot back", () =>
  Effect.gen(function* () {
    const tier = { id: "broken", kind: "one_off", grants: [] };
    expect(yield* refusal({ catalog: testCatalog, pack: "nope" })).toBe("unknown-pack");
    expect(yield* refusal({ catalog: testCatalog, pack: "plan" })).toBe("not-a-pack");
    expect(yield* refusal({ catalog: handBuilt([{ ...tier }]), pack: "broken" })).toBe(
      "no-credits",
    );
    expect(
      yield* refusal({
        catalog: handBuilt([{ ...tier, credits: 100 }]),
        pack: "broken",
      }),
    ).toBe("no-price");
    expect(new AutoTopUpInvalid({ pack: "plan", reason: "not-a-pack" })._tag).toBe(
      "AutoTopUpInvalid",
    );
  }),
);
