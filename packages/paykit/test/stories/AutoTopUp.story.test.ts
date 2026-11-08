import { Story } from "@alchemy.run/domain/Story";
import { expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog, creditRatesOf, type Catalog } from "../../src/Catalog.ts";
import { feature, messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import {
  PaymentDeclined,
  Payments,
  paymentsRouter,
  type MoneyProvider,
} from "../../src/Payments.ts";
import { PaymentsManual } from "../../src/PaymentsManual.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { PaymentsStripe } from "../../src/PaymentsStripe.ts";
import {
  AutoTopUpInvalid,
  autoTopUp,
  topUpCommandId,
  topUpFailureCommandId,
} from "../../src/Subscription/AutoTopUp.policy.ts";
import { BillingState } from "../../src/Subscription/BillingState.view.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { CreditsGranted, GrantCredits } from "../../src/Subscription/GrantCredits.command.ts";
import {
  CreditsPurchased,
  PurchaseCredits,
} from "../../src/Subscription/PurchaseCredits.command.ts";
import { TopUpFailed } from "../../src/Subscription/RecordTopUpFailure.command.ts";
import { Subscribe, SubscriptionActivated } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { TopUpCooldownCleared } from "../../src/Subscription/TopUpCooldownElapsed.command.ts";
import { TrackUsage, UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";

const ai = feature({ id: "ai", name: "AI", creditRates: { default: 1, "gpt-large": 10 } });
const price = { amount: 1_900, currency: "usd", interval: "month" as const };

const plan = tier({
  id: "plan",
  price,
  credits: 2_000,
  topUp: { threshold: 1_000 },
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
      topUp: { threshold: 1_000 },
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
      topUp: { threshold: 1_000 },
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

const storyWith = (
  player: MoneyProvider,
  options: { readonly pack: string; readonly cooldown?: Duration.Duration } | null,
) => {
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
              autoTopUp({
                catalog: testCatalog,
                pack: options.pack,
                ...(options.cooldown === undefined ? {} : { cooldown: options.cooldown }),
              }).pipe(Layer.orDie),
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
    Story.call(Payments.charge, {
      account: account.id,
      amount: 4_900,
      currency: "usd",
      commandId,
    }),
    Story.returned(Payments.charge, { chargeId: "ch_1" }),
    Story.then(
      account,
      new CreditsPurchased({
        tier: "pack",
        amount: 5_000,
        price: pack.price!,
        rates,
        chargeId: "ch_1",
        balanceAfter: 5_500,
        prepaidAfter: 5_000,
      }),
    ),
    // The page carries the line the standing refills on, not just the pack.
    Story.view(BillingState, account, { topUp: { threshold: 1_000 } }),
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
    Story.call(Payments.charge, {
      account: account.id,
      amount: 990,
      currency: "usd",
      commandId,
    }),
    Story.returned(Payments.charge, { chargeId: "ch_1" }),
    // The 100-credit pack lifts the pool exactly back to the line, so the
    // next spend is already below it: a spend is not a second crossing.
    Story.then(
      account,
      new CreditsPurchased({
        tier: "pack_small",
        amount: 100,
        price: smallPack.price!,
        rates,
        chargeId: "ch_1",
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

const halfHour = Duration.minutes(30);
const laterTen = at("2030-01-01T00:10:00Z");
const cooldownEnds = at("2030-01-01T00:30:00Z");
const nextCooldownEnds = at("2030-01-01T01:00:00Z");

it.effect("defers a crossing inside the cooldown, then buys when the deadline clears it", () =>
  storyWith(PaymentsMemory(), { pack: "pack", cooldown: halfHour })(
    ...subscribed,
    // 2,000 -> 500 crosses the line and buys a pack, which opens a 30-minute
    // cooldown recorded on the event that bought it.
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
    Story.call(Payments.charge, {
      account: account.id,
      amount: 4_900,
      currency: "usd",
      commandId: topUpCommandId(account.id, 2),
    }),
    Story.returned(Payments.charge, { chargeId: "ch_1" }),
    Story.then(
      account,
      new CreditsPurchased({
        tier: "pack",
        amount: 5_000,
        price: pack.price!,
        rates,
        chargeId: "ch_1",
        cooldownUntil: cooldownEnds,
        balanceAfter: 5_500,
        prepaidAfter: 5_000,
      }),
    ),
    // The page says when the next refill may buy, so an operator can tell a
    // deferred crossing from a broken policy.
    Story.view(BillingState, account, { topUpCooldownUntil: cooldownEnds }),
    // A second crossing inside the window is deferred: the pool is spent down
    // again and nothing is invoiced, because the pack is not the only bound.
    Story.clock(laterTen),
    Story.when(account, new TrackUsage({ feature: "ai", amount: 5_000 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "ai",
        amount: 5_000,
        cost: 5_000,
        creditsAfter: 500,
        usedAfter: 6_500,
        remainingAfter: 500,
      }),
    ),
    // The scheduled deadline clears the cooldown, and the policy buys the
    // refill it deferred rather than the one it refused.
    Story.clock(cooldownEnds),
    Story.then(account, new TopUpCooldownCleared()),
    Story.call(Payments.charge, {
      account: account.id,
      amount: 4_900,
      currency: "usd",
      commandId: topUpCommandId(account.id, 5),
    }),
    Story.returned(Payments.charge, { chargeId: "ch_2" }),
    Story.then(
      account,
      new CreditsPurchased({
        tier: "pack",
        amount: 5_000,
        price: pack.price!,
        rates,
        chargeId: "ch_2",
        cooldownUntil: nextCooldownEnds,
        // The plan's credits were spent first, so what is left of the first
        // pack is all prepaid: 10,000 bought, 4,500 burned.
        balanceAfter: 5_500,
        prepaidAfter: 5_500,
      }),
    ),
    Story.view(Entitlements, account, { credits: 5_500 }),
  ),
);

it.effect("buys nothing when the pool recovered before the cooldown ended", () =>
  storyWith(PaymentsMemory(), { pack: "pack", cooldown: halfHour })(
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
    Story.call(Payments.charge, {
      account: account.id,
      amount: 4_900,
      currency: "usd",
      commandId: topUpCommandId(account.id, 2),
    }),
    Story.returned(Payments.charge, { chargeId: "ch_1" }),
    Story.then(
      account,
      new CreditsPurchased({
        tier: "pack",
        amount: 5_000,
        price: pack.price!,
        rates,
        chargeId: "ch_1",
        cooldownUntil: cooldownEnds,
        balanceAfter: 5_500,
        prepaidAfter: 5_000,
      }),
    ),
    // A crossing inside the window, then a grant that lifts the pool back over
    // the line before the deadline: the deferred refill is no longer needed.
    Story.clock(laterTen),
    Story.when(account, new TrackUsage({ feature: "ai", amount: 5_000 })),
    Story.then(
      account,
      new UsageRecorded({
        feature: "ai",
        amount: 5_000,
        cost: 5_000,
        creditsAfter: 500,
        usedAfter: 6_500,
        remainingAfter: 500,
      }),
    ),
    Story.when(account, new GrantCredits({ amount: 1_000 })),
    Story.then(account, new CreditsGranted({ amount: 1_000, balanceAfter: 1_500 })),
    Story.clock(cooldownEnds),
    Story.then(account, new TopUpCooldownCleared()),
    Story.view(Entitlements, account, { credits: 1_500 }),
    Story.view(BillingState, account, { credits: 1_500 }),
  ),
);

it.effect("invoices the pack when the provider has no saved method to charge", () =>
  // A manual provider bills by transfer: it declares `invoice` and not
  // `charge`, so the crossing takes the invoice path and nothing changes.
  storyWith(PaymentsManual(), { pack: "pack" })(
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
    Story.call(Payments.createInvoice, {
      account: account.id,
      amount: 4_900,
      currency: "usd",
      commandId: topUpCommandId(account.id, 2),
    }),
    Story.returned(Payments.createInvoice, { invoiceId: "manual_invoice_1" }),
    Story.then(
      account,
      new CreditsPurchased({
        tier: "pack",
        amount: 5_000,
        price: pack.price!,
        rates,
        invoiceId: "manual_invoice_1",
        balanceAfter: 5_500,
        prepaidAfter: 5_000,
      }),
    ),
    Story.view(Entitlements, account, { credits: 5_500 }),
  ),
);

it.effect("falls back to the invoice when the saved method is declined", () => {
  // Declares `charge` and fails it: a declined card is not an account that may
  // not be refilled, so the same crossing is invoiced instead.
  const declined = new PaymentDeclined({
    provider: "stripe",
    code: "card_declined",
    message: "the card was declined",
  });

  const processor = PaymentsStripe({
    bindings: {
      createCheckoutSession: () => Effect.succeed({ url: "https://checkout.test" }),
      createCustomerSession: () => Effect.succeed({ url: "https://portal.test" }),
      charge: () => Effect.fail(declined),
      createInvoice: () => Effect.succeed({ invoiceId: "in_fallback" }),
    },
  });

  return storyWith(processor, { pack: "pack" })(
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
    Story.call(Payments.charge, {
      account: account.id,
      amount: 4_900,
      currency: "usd",
      commandId: topUpCommandId(account.id, 2),
    }),
    Story.failed(Payments.charge, declined),
    Story.call(Payments.createInvoice, {
      account: account.id,
      amount: 4_900,
      currency: "usd",
      commandId: topUpCommandId(account.id, 2),
    }),
    Story.returned(Payments.createInvoice, { invoiceId: "in_fallback" }),
    Story.then(
      account,
      new CreditsPurchased({
        tier: "pack",
        amount: 5_000,
        price: pack.price!,
        rates,
        invoiceId: "in_fallback",
        balanceAfter: 5_500,
        prepaidAfter: 5_000,
      }),
    ),
    Story.view(Entitlements, account, { credits: 5_500 }),
  );
});

it.effect(
  "records the refill it could not buy, and leaves the pool where the spend left it",
  () => {
    // Both money paths refuse: the saved method is declined and the invoice
    // cannot be opened, so the crossing had no way to buy the pack.
    const declined = new PaymentDeclined({
      provider: "stripe",
      code: "card_declined",
      message: "the card was declined",
    });

    const processor = PaymentsStripe({
      bindings: {
        createCheckoutSession: () => Effect.succeed({ url: "https://checkout.test" }),
        createCustomerSession: () => Effect.succeed({ url: "https://portal.test" }),
        charge: () => Effect.fail(declined),
        createInvoice: () => Effect.fail(declined),
      },
    });

    return storyWith(processor, { pack: "pack" })(
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
      Story.call(Payments.charge, {
        account: account.id,
        amount: 4_900,
        currency: "usd",
        commandId: topUpCommandId(account.id, 2),
      }),
      Story.failed(Payments.charge, declined),
      Story.call(Payments.createInvoice, {
        account: account.id,
        amount: 4_900,
        currency: "usd",
        commandId: topUpCommandId(account.id, 2),
      }),
      Story.failed(Payments.createInvoice, declined),
      // Nothing was charged and nothing was granted, so the failure is the whole
      // record of the crossing — and the pool is exactly where the spend left it.
      Story.then(
        account,
        new TopUpFailed({
          tier: "pack",
          price: pack.price!,
          provider: "stripe",
          reason: "PaymentDeclined",
          at: start,
          commandId: topUpFailureCommandId(account.id, 2),
        }),
      ),
      Story.view(Entitlements, account, { credits: 500 }),
      Story.view(BillingState, account, {
        topUpFailure: {
          tier: "pack",
          price: pack.price!,
          provider: "stripe",
          reason: "PaymentDeclined",
          at: start,
        },
      }),
    );
  },
);

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

// A catalog where the tier states its own pack and its own bound, so what the
// deployment names is only the fallback — the case a deployment with a small
// free tier and a large paid one actually has.
const picky = tier({
  id: "picky",
  price,
  credits: 2_000,
  topUp: { threshold: 1_000, cooldown: Duration.hours(1), pack: "pack_small" },
  grants: [allowance(messages, { included: 100 })],
});

const pickyCatalog = Effect.runSync(
  catalog({ features: [messages, ai], tiers: [picky, pack, smallPack] }),
);

const pickyTerms = allowancesOf(pickyCatalog, "picky")!;
const pickyLine = { threshold: 1_000, cooldown: Duration.hours(1), pack: "pack_small" };
const tierCooldownEnds = at("2030-01-01T01:00:00Z");

const subscribedPicky = [
  Story.provide(Actor, system("test")),
  Story.clock(start),
  Story.when(
    account,
    new Subscribe({
      tier: "picky",
      allowances: pickyTerms,
      price,
      credits: 2_000,
      creditsExpire: "period",
      topUp: pickyLine,
      rates,
    }),
  ),
  Story.then(
    account,
    new SubscriptionActivated({
      tier: "picky",
      allowances: pickyTerms,
      remaining: { messages: 100 },
      credits: 2_000,
      creditsExpire: "period",
      topUp: pickyLine,
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

it.effect("buys the pack and honours the bound the tier states, not the deployment's", () => {
  const handlers = PaykitHandlers.pipe(
    Layer.provide(MemoryBillingReadStore),
    Layer.provideMerge(paymentsRouter(PaymentsMemory())),
  );

  // The deployment names the big pack and a half-hour bound; this tier states
  // both of its own, and both its own win.
  return Story.make(PaykitModel, {
    layer: handlers.pipe(
      Layer.provideMerge(
        autoTopUp({
          catalog: pickyCatalog,
          pack: "pack",
          cooldown: halfHour,
        }).pipe(Layer.orDie),
      ),
    ),
  })(
    ...subscribedPicky,
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
    // The tier's pack is the product bought, so the provider is asked for the
    // small pack's price, not the deployment's default.
    Story.call(Payments.charge, {
      account: account.id,
      amount: 990,
      currency: "usd",
      commandId: topUpCommandId(account.id, 2),
    }),
    Story.returned(Payments.charge, { chargeId: "ch_1" }),
    Story.then(
      account,
      new CreditsPurchased({
        tier: "pack_small",
        amount: 100,
        price: smallPack.price!,
        rates,
        chargeId: "ch_1",
        // An hour, because the tier said an hour: a scheduled change moves
        // this bound at the boundary along with the line and the pack.
        cooldownUntil: tierCooldownEnds,
        balanceAfter: 600,
        prepaidAfter: 100,
      }),
    ),
    Story.view(Entitlements, account, { credits: 600 }),
    Story.view(BillingState, account, { topUp: pickyLine }),
  );
});
