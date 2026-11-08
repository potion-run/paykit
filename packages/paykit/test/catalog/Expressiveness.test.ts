import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { allowance } from "../../src/Allowance.ts";
import {
  CatalogAdditionalCurrency,
  CatalogPricingBand,
  CatalogPricingConflict,
  CatalogPricingCurrency,
  CatalogPricingWithoutBilling,
  CatalogProrateOnMetered,
  CatalogQuantityCap,
  CatalogQuantityKind,
  CatalogQuantityPricing,
  CatalogQuantityResets,
  CatalogQuantityWithoutPrice,
  CatalogRateCardOnQuantity,
  CatalogRateCardOverride,
  CatalogUnknownVariant,
  CatalogVariantCycle,
  CatalogVariantOnPack,
  CatalogVolumeRateRises,
  allowancesOf,
  catalog,
  defineCatalog,
  ratesOf,
  tierOf,
  tierTermsOf,
} from "../../src/Catalog.ts";
import { catalogMismatchOf } from "../../src/CatalogGuard.ts";
import { creditRateOf, feature, messages, rateCard } from "../../src/Feature.ts";
import {
  chargeOfPricing,
  priceOf,
  pricedLines,
  pricing,
  soleUnitPriceOf,
  unitsOf,
} from "../../src/Pricing.ts";
import {
  nextResetAt,
  periodTiedReset,
  resetOf,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { TierId, priceFor, tier } from "../../src/Tier.ts";

const usd = (amount: number, units?: number) => ({
  kind: "unit" as const,
  amount,
  currency: "usd",
  ...(units === undefined ? {} : { units }),
});

const failureOf = (t: ReturnType<typeof tier>) => {
  const result = defineCatalog({ features: [messages], tiers: [t] });

  return Result.isFailure(result) ? result.failure : null;
};

describe("a price is a function of the billable count", () => {
  it("bills whole packages, so a partial package is still a package", () => {
    const packagePrice = pricing(usd(500, 1_000));
    // $5 for each 1,000 units.
    expect(priceOf(packagePrice, 0)).toBe(0);
    expect(priceOf(packagePrice, 1)).toBe(500);
    expect(priceOf(packagePrice, 1_000)).toBe(500);
    expect(priceOf(packagePrice, 1_001)).toBe(1_000);
    expect(priceOf(packagePrice, 2_500)).toBe(1_500);
  });

  it("charges one event the difference the event makes, so the order does not matter", () => {
    const packagePrice = pricing(usd(500, 1_000));
    // 600 then 900: the first is one package, the second completes the second.
    expect(chargeOfPricing(packagePrice, 0, 600)).toBe(500);
    expect(chargeOfPricing(packagePrice, 600, 1_500)).toBe(500);
    expect(chargeOfPricing(packagePrice, 0, 1_500)).toBe(1_000);
    expect(chargeOfPricing(packagePrice, 1_500, 2_000)).toBe(0);
  });

  it("prices a graduated ladder band by band", () => {
    const graduated = pricing({
      kind: "graduated",
      currency: "usd",
      bands: [
        { upTo: 10_000, amount: 1, currency: "usd" },
        { upTo: "inf", amount: 5, currency: "usd", units: 1_000 },
      ],
    });

    // The first 10,000 at one cent each, then $5 per 1,000.
    expect(priceOf(graduated, 10_000)).toBe(10_000);
    // 10,000 at one cent each, then 5,000 at $5 per 1,000: $25.
    expect(priceOf(graduated, 15_000)).toBe(10_025);
    // 500 units in the first band and 500 in the second: 500 + $5.
    expect(chargeOfPricing(graduated, 9_500, 10_500)).toBe(505);
    expect(chargeOfPricing(graduated, 10_000, 11_000)).toBe(5);
  });

  it("prices a volume ladder at the band the total lands in", () => {
    const volume = pricing({
      kind: "volume",
      currency: "usd",
      bands: [
        { upTo: 10_000, amount: 1, currency: "usd" },
        { upTo: "inf", amount: 5, currency: "usd", units: 1_000 },
      ],
    });

    // 15,000 units all land in the second band: 15 packages of $5.
    expect(priceOf(volume, 15_000)).toBe(75);
    // Crossing the boundary reprices the whole total, so the event that
    // crosses bills the difference rather than the new units alone. A volume
    // ladder can reprice the period downward; the delta is signed.
    expect(chargeOfPricing(volume, 9_999, 10_001)).toBe(55 - 9_999);
  });

  it("splits a charge into the lines a report carries", () => {
    const graduated = pricing({
      kind: "graduated",
      currency: "usd",
      bands: [
        { upTo: 100, amount: 1, currency: "usd" },
        { upTo: "inf", amount: 2, currency: "usd" },
      ],
    });

    const lines = pricedLines(graduated, 90, 110);
    expect(lines.map((line) => line.quantity)).toEqual([10, 10]);
    expect(lines.map((line) => line.amount)).toEqual([10, 20]);
    expect(lines.reduce((sum, line) => sum + line.amount, 0)).toBe(
      chargeOfPricing(graduated, 90, 110),
    );
    expect(lines.reduce((sum, line) => sum + line.quantity, 0)).toBe(20);
  });

  it("names one price only when the pricing has one", () => {
    expect(soleUnitPriceOf(pricing(usd(2)))?.amount).toBe(2);
    expect(
      soleUnitPriceOf(
        pricing({
          kind: "graduated",
          currency: "usd",
          bands: [
            { upTo: 10, amount: 1, currency: "usd" },
            { upTo: "inf", amount: 2, currency: "usd" },
          ],
        }),
      ),
    ).toBe(null);
    expect(unitsOf({ amount: 500, currency: "usd", units: 1_000 })).toBe(1_000);
    expect(unitsOf({ amount: 500, currency: "usd" })).toBe(1);
  });
});

describe("the catalog validates the price shapes it can express", () => {
  const paid = (p: ReturnType<typeof pricing>, id = "pro") =>
    tier({
      id,
      price: { amount: 1_900, currency: "usd", interval: "month" },
      grants: [
        allowance(messages, {
          included: 100,
          overage: "bill",
          pricing:
            p._tag === "unit"
              ? { kind: "unit", amount: p.unitPrice.amount, currency: p.unitPrice.currency }
              : {
                  kind: p._tag,
                  currency: p.currency,
                  bands: p.bands.map((band) => ({
                    upTo: band.upTo,
                    amount: band.unitPrice.amount,
                    currency: band.unitPrice.currency,
                  })),
                },
        }),
      ],
    });

  it("refuses bands that are out of order, or do not end at inf", () => {
    const outOfOrder = failureOf(
      paid(
        pricing({
          kind: "graduated",
          currency: "usd",
          bands: [
            { upTo: 10, amount: 1, currency: "usd" },
            { upTo: 5, amount: 2, currency: "usd" },
            { upTo: "inf", amount: 3, currency: "usd" },
          ],
        }),
      ),
    );

    expect(outOfOrder === null ? false : Schema.is(CatalogPricingBand)(outOfOrder)).toBe(true);

    const noEnd = failureOf(
      paid(
        pricing({
          kind: "graduated",
          currency: "usd",
          bands: [{ upTo: 10, amount: 1, currency: "usd" }],
        }),
      ),
    );

    expect(noEnd === null ? false : Schema.is(CatalogPricingBand)(noEnd)).toBe(true);
  });

  it("refuses a volume ladder whose rate rises as the volume grows", () => {
    const failure = failureOf(
      paid(
        pricing({
          kind: "volume",
          currency: "usd",
          bands: [
            { upTo: 10, amount: 1, currency: "usd" },
            { upTo: "inf", amount: 2, currency: "usd" },
          ],
        }),
      ),
    );

    expect(failure === null ? false : Schema.is(CatalogVolumeRateRises)(failure)).toBe(true);
  });

  it("refuses a price where nothing is billed", () => {
    const result = defineCatalog({
      features: [messages],
      tiers: [
        tier({
          id: "broken",
          grants: [
            {
              ...allowance(messages, { included: 100 }),
              pricing: { _tag: "unit", unitPrice: { amount: 1, currency: "usd" } },
            },
          ],
        }),
      ],
    });

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      expect(Schema.is(CatalogPricingWithoutBilling)(result.failure)).toBe(true);
    }
  });

  it("refuses two prices on one allowance", () => {
    const result = defineCatalog({
      features: [messages],
      tiers: [
        tier({
          id: "both",
          grants: [
            {
              ...allowance(messages, {
                included: 0,
                overage: "bill",
                unitPrice: { amount: 1, currency: "usd" },
              }),
              pricing: { _tag: "unit", unitPrice: { amount: 2, currency: "usd" } },
            },
          ],
        }),
      ],
    });

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      expect(Schema.is(CatalogPricingConflict)(result.failure)).toBe(true);
    }
  });

  it("refuses a price in a currency the tier does not sell in", () => {
    const failure = failureOf(
      tier({
        id: "eur",
        price: { amount: 1_900, currency: "eur", interval: "month" },
        grants: [
          allowance(messages, {
            included: 100,
            overage: "bill",
            pricing: { kind: "unit", amount: 1, currency: "usd" },
          }),
        ],
      }),
    );

    expect(failure === null ? false : Schema.is(CatalogPricingCurrency)(failure)).toBe(true);
  });

  it("validates a non-consumable quantity: one seat price, no reset, a cap", () => {
    const seats = feature({ id: "seats", kind: "non_consumable" });

    const seatTier = (grant: ReturnType<typeof allowance>) =>
      tier({
        id: "team",
        price: { amount: 1_900, currency: "usd", interval: "month" },
        grants: [grant],
      });

    const seatFailureOf = (t: ReturnType<typeof tier>) => {
      const result = defineCatalog({ features: [seats], tiers: [t] });

      return Result.isFailure(result) ? result.failure : null;
    };

    const valid = defineCatalog({
      features: [seats],
      tiers: [
        seatTier(
          allowance(seats, {
            included: 5,
            overage: "bill",
            pricing: { kind: "unit", amount: 1_000, currency: "usd" },
            cap: 20,
          }),
        ),
      ],
    });

    expect(Result.isSuccess(valid)).toBe(true);

    const resets = seatFailureOf(
      seatTier({
        ...allowance(seats, { included: 5, overage: "allow" }),
        resets: "day",
      }),
    );

    expect(resets === null ? false : Schema.is(CatalogQuantityResets)(resets)).toBe(true);

    const ladder = seatFailureOf(
      seatTier(
        allowance(seats, {
          included: 5,
          overage: "bill",
          pricing: {
            kind: "graduated",
            currency: "usd",
            bands: [
              { upTo: 10, amount: 1, currency: "usd" },
              { upTo: "inf", amount: 2, currency: "usd" },
            ],
          },
        }),
      ),
    );

    expect(ladder === null ? false : Schema.is(CatalogQuantityPricing)(ladder)).toBe(true);

    const noPrice = seatFailureOf(seatTier(allowance(seats, { included: 5, overage: "bill" })));
    expect(noPrice === null ? false : Schema.is(CatalogQuantityWithoutPrice)(noPrice)).toBe(true);

    const cap = seatFailureOf(
      seatTier(allowance(seats, { included: 5, overage: "allow", cap: 2 })),
    );

    expect(cap === null ? false : Schema.is(CatalogQuantityCap)(cap)).toBe(true);
  });

  it("refuses a quantity on a metered feature, and a rate card on a quantity", () => {
    const quantityOnMetered = failureOf(
      tier({
        id: "wrong",
        grants: [
          {
            ...allowance(messages, { included: 5 }),
            kind: "non_consumable",
          },
        ],
      }),
    );

    expect(
      quantityOnMetered === null ? false : Schema.is(CatalogQuantityKind)(quantityOnMetered),
    ).toBe(true);

    const cardOnQuantity = defineCatalog({
      features: [
        {
          id: "seats" as never,
          kind: "non_consumable",
          creditRates: { default: 1 },
        } as never,
      ],
      tiers: [],
    });

    expect(Result.isFailure(cardOnQuantity)).toBe(true);

    if (Result.isFailure(cardOnQuantity)) {
      expect(Schema.is(CatalogRateCardOnQuantity)(cardOnQuantity.failure)).toBe(true);
    }

    const prorateOnMetered = failureOf(
      tier({
        id: "metered",
        grants: [allowance(messages, { included: 5, prorate: "immediate" })],
      }),
    );

    expect(
      prorateOnMetered === null ? false : Schema.is(CatalogProrateOnMetered)(prorateOnMetered),
    ).toBe(true);
  });

  it("accepts a package price and a two-band ladder", () => {
    const result = defineCatalog({
      features: [messages],
      tiers: [
        paid(pricing(usd(500, 1_000)), "package"),
        paid(
          pricing({
            kind: "graduated",
            currency: "usd",
            bands: [
              { upTo: 10_000, amount: 1, currency: "usd" },
              { upTo: "inf", amount: 5, currency: "usd", units: 1_000 },
            ],
          }),
          "ladder",
        ),
      ],
    });

    expect(Result.isSuccess(result)).toBe(true);
  });
});

describe("a rate card prices on a dimension, a property match and a multiplier", () => {
  it("takes the named dimension, then a matching rule, then default", () => {
    const card = rateCard({ default: 1, dimensions: { "gpt-large": 10 } });
    expect(creditRateOf(card)).toBe(1);
    expect(creditRateOf(card, { dimension: "gpt-large" })).toBe(10);
    expect(creditRateOf(card, { dimension: "unknown" })).toBe(1);
    expect(creditRateOf(card, { properties: { size: "large" } })).toBe(1);

    const ruled = rateCard({
      default: 1,
      rules: [{ match: { size: "large" }, credits: 16 }],
    });

    expect(creditRateOf(ruled, { properties: { size: "large" } })).toBe(16);
    expect(creditRateOf(ruled, { properties: { size: "small" } })).toBe(1);
  });

  it("applies every matching multiplier, then clamps at zero", () => {
    const card = rateCard({
      default: 10,
      multipliers: [
        { match: { lifecycle: "spot" }, factor: 0.3 },
        { match: { region: "eu" }, add: 2 },
      ],
    });

    expect(creditRateOf(card, { properties: { lifecycle: "spot" } })).toBe(3);
    expect(creditRateOf(card, { properties: { lifecycle: "spot", region: "eu" } })).toBe(5);

    const negative = rateCard({
      default: 1,
      multipliers: [{ match: { free: "yes" }, add: -10 }],
    });

    expect(creditRateOf(negative, { properties: { free: "yes" } })).toBe(0);
  });

  it("lets a tier replace one feature's card", () => {
    const ai = feature({ id: "ai", creditRates: { default: 1, "gpt-large": 10 } });

    const result = Effect.runSync(
      catalog({
        features: [ai, messages],
        tiers: [
          tier({
            id: "pro",
            price: { amount: 100, currency: "usd", interval: "month" },
            credits: 100,
            grants: [allowance(messages, { included: 1 })],
            rateCard: { ai: { default: 5, dimensions: { "gpt-large": 99 } } },
          }),
        ],
      }),
    );

    expect(ratesOf(result, "pro")?.ai).toEqual({
      default: 5,
      dimensions: { "gpt-large": 99 },
    });
  });

  it("refuses an override for a feature the catalog does not price in credits", () => {
    const result = defineCatalog({
      features: [messages],
      tiers: [
        tier({
          id: "pro",
          grants: [allowance(messages, { included: 1 })],
          rateCard: { messages: { default: 1 } },
        }),
      ],
    });

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      expect(Schema.is(CatalogRateCardOverride)(result.failure)).toBe(true);
    }
  });
});

describe("a variant is a named alternative of a base tier", () => {
  const monthly = tier({
    id: "pro",
    price: { amount: 1_900, currency: "usd", interval: "month" },
    credits: 1_000,
    grants: [allowance(messages, { included: 2_000 })],
  });

  const annual = tier({
    id: "pro_annual",
    variantOf: "pro",
    customize: { price: { amount: 19_000, currency: "usd", interval: "annual" } },
  });

  it("inherits every field it does not state", () => {
    const result = Effect.runSync(catalog({ features: [messages], tiers: [monthly, annual] }));
    const resolved = tierOf(result, "pro_annual");
    expect(resolved?.price?.amount).toBe(19_000);
    expect(resolved?.price?.interval).toBe("annual");
    expect(resolved?.credits).toBe(1_000);
    expect(allowancesOf(result, "pro_annual")?.messages?.included).toBe(2_000);
    expect(resolved?.variantOf).toBeUndefined();
  });

  it("refuses an unknown base and a cycle", () => {
    const unknown = defineCatalog({
      features: [messages],
      tiers: [
        tier({
          id: "annual",
          variantOf: "missing",
          grants: [allowance(messages, { included: 1 })],
        }),
      ],
    });

    expect(Result.isFailure(unknown)).toBe(true);

    if (Result.isFailure(unknown)) {
      expect(Schema.is(CatalogUnknownVariant)(unknown.failure)).toBe(true);
    }

    const cycle = defineCatalog({
      features: [messages],
      tiers: [
        tier({ id: "a", variantOf: "b", grants: [allowance(messages, { included: 1 })] }),
        tier({ id: "b", variantOf: "a", grants: [allowance(messages, { included: 1 })] }),
      ],
    });

    expect(Result.isFailure(cycle)).toBe(true);

    if (Result.isFailure(cycle)) {
      expect(Schema.is(CatalogVariantCycle)(cycle.failure)).toBe(true);
    }

    const pack = defineCatalog({
      features: [messages],
      tiers: [
        {
          id: TierId.make("pack"),
          kind: "one_off",
          variantOf: TierId.make("pro"),
          price: { amount: 100, currency: "usd", interval: "month" },
          credits: 100,
          grants: [],
        },
      ],
    });

    expect(Result.isFailure(pack)).toBe(true);

    if (Result.isFailure(pack)) {
      expect(Schema.is(CatalogVariantOnPack)(pack.failure)).toBe(true);
    }
  });
});

describe("a tier can be sold in more than one currency", () => {
  const price = {
    amount: 1_900,
    currency: "usd",
    interval: "month" as const,
    additionalCurrencies: [
      { currency: "eur", amount: 1_800 },
      { currency: "gbp", amount: 1_600 },
    ],
  };

  it("states each currency explicitly and never converts", () => {
    expect(priceFor(price, "usd")?.amount).toBe(1_900);
    expect(priceFor(price, "eur")?.amount).toBe(1_800);
    expect(priceFor(price, "gbp")?.amount).toBe(1_600);
    expect(priceFor(price, "jpy")).toBe(null);
  });

  it("resolves the currency a caller asks for, and refuses one the tier does not sell", () => {
    const result = Effect.runSync(
      catalog({
        features: [messages],
        tiers: [
          tier({
            id: "pro",
            price,
            grants: [allowance(messages, { included: 1 })],
          }),
        ],
      }),
    );

    expect(tierTermsOf(result, "pro", "eur")?.price?.amount).toBe(1_800);
    expect(tierTermsOf(result, "pro", "eur")?.price?.currency).toBe("eur");
    expect(tierTermsOf(result, "pro", "jpy")).toBe(null);
    // The guard accepts the same price the tier states in that currency.
    expect(
      catalogMismatchOf(result, {
        tier: "pro",
        price: { amount: 1_800, currency: "eur", interval: "month" },
      }),
    ).toBe(null);
  });

  it("refuses a repeated currency", () => {
    const result = defineCatalog({
      features: [messages],
      tiers: [
        tier({
          id: "pro",
          price: {
            ...price,
            additionalCurrencies: [{ currency: "usd", amount: 1_900 }],
          },
          grants: [allowance(messages, { included: 1 })],
        }),
      ],
    });

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      expect(Schema.is(CatalogAdditionalCurrency)(result.failure)).toBe(true);
    }
  });
});

describe("a rollover can be capped, and a reset can run on its own schedule", () => {
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  const start = at("2030-01-01T00:00:00Z");
  const end = at("2030-02-01T00:00:00Z");

  const state = (over: Partial<SubscribedState> = {}): SubscribedState =>
    ({
      _tag: "Subscribed",
      tier: "pro",
      status: "active",
      period: { start, end, anchorTz: "UTC" },
      interval: "month",
      cancelAtPeriodEnd: false,
      credits: 0,
      creditsExpire: "period",
      rates: {},
      usage: {},
      remaining: { messages: 1_500 },
      holds: {},
      allowances: {},
      refs: {},
      trialUsed: false,
      dedupeKeys: {},
      dunningAttempts: 0,
      ...over,
    }) as SubscribedState;

  it("carries at most the cap, not at most the grant", () => {
    const capped = allowance(messages, { included: 1_000, carryOver: true, carryCap: 250 });
    expect(resetOf(state(), "messages", capped)).toEqual({
      remaining: 1_250,
      carried: 250,
      kept: false,
    });
  });

  it("knows which schedules the period owns", () => {
    expect(periodTiedReset({ resets: "month" })).toBe(true);
    expect(periodTiedReset({ resets: "annual" })).toBe(true);
    expect(periodTiedReset({ resets: "day" })).toBe(false);
    expect(periodTiedReset({ resets: "month", resetEvery: 2 })).toBe(false);
  });

  it("moves a daily boundary by a day and a quarterly one by three months", () => {
    expect(nextResetAt(start, { resets: "day" })?.epochMilliseconds).toBe(
      DateTime.add(start, { days: 1 }).epochMilliseconds,
    );
    expect(nextResetAt(start, { resets: "hour", resetEvery: 4 })?.epochMilliseconds).toBe(
      DateTime.add(start, { hours: 4 }).epochMilliseconds,
    );
    expect(nextResetAt(start, { resets: "quarter" })?.epochMilliseconds).toBe(
      DateTime.add(start, { months: 3 }).epochMilliseconds,
    );
    expect(nextResetAt(start, { resets: "never" })).toBe(null);
  });

  it("leaves an independently scheduled allowance to its own boundary", () => {
    const daily = allowance(messages, { included: 100, resets: "day" });
    // The period close does not touch a daily allowance: its own `ResetAllowance`
    // is what resets it, so the close keeps its usage and count.
    expect(resetOf(state(), "messages", daily)).toEqual({
      remaining: 1_500,
      carried: 0,
      kept: true,
    });
  });
});
