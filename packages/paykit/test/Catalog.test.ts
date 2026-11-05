import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { allowance, grant } from "../src/Allowance.ts";
import {
  CatalogCarryOverNeverResets,
  CatalogCarryOverOnFlag,
  CatalogCreditRatesOnFlag,
  CatalogCreditFeatureHasAllowance,
  CatalogCreditGrantInvalid,
  CatalogCreditRateInvalid,
  CatalogCreditRateMissing,
  CatalogDuplicateAllowance,
  CatalogDuplicateFeature,
  CatalogDuplicateTier,
  CatalogEmptyTier,
  CatalogError,
  CatalogFlagNotGranted,
  CatalogInvalid,
  CatalogOneOffCredits,
  CatalogOneOffCreditsExpire,
  CatalogOneOffGrant,
  CatalogOneOffWithoutPrice,
  CatalogMoneyCapWithoutUnitPrice,
  CatalogUnitPriceCurrency,
  CatalogUnitPriceWithoutBilling,
  CatalogUnknownFeature,
  CatalogUnlimitedOverage,
  allowancesOf,
  catalog,
  defineCatalog,
  featureOf,
  tierOf,
} from "../src/Catalog.ts";
import { feature, messages } from "../src/Feature.ts";
import { TierId, tier } from "../src/Tier.ts";

const seats = feature({ id: "seats", name: "Seats" });
const sso = feature({ id: "sso", name: "SSO", kind: "flag" });
const ai = feature({ id: "ai", name: "AI", creditRates: { default: 1, "gpt-large": 10 } });

const free = tier({
  id: "free",
  name: "Free",
  grants: [allowance(messages, { included: 100 })],
});

const pro = tier({
  id: "pro",
  name: "Pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [
    allowance(messages, { included: 2000, overage: "bill" }),
    allowance(seats, { included: 5, resets: "never" }),
  ],
});

const valid = { features: [messages, seats], tiers: [free, pro] };

describe("catalog", () => {
  it("applies allowance defaults", () => {
    expect(allowance(messages, { included: 100 })).toEqual({
      feature: "messages",
      kind: "metered",
      included: 100,
      overage: "block",
      resets: "month",
      carryOver: false,
    });
  });

  it("keeps identity and display name separate on a declaration", () => {
    expect(messages.id).toBe("messages");
    expect(messages.name).toBe("Messages");
    expect(seats.id).toBe("seats");
  });

  it.effect("builds a catalog and looks up its features and allowances", () =>
    Effect.gen(function* () {
      const built = yield* catalog(valid);
      expect(built.features.map((feature) => feature.id)).toEqual(["messages", "seats"]);
      expect(built.tiers.map((tier) => tier.id)).toEqual(["free", "pro"]);
      expect(tierOf(built, "pro")?.name).toBe("Pro");
      expect(featureOf(built, "seats")?.name).toBe("Seats");
      expect(allowancesOf(built, "pro")).toEqual({
        messages: {
          feature: "messages",
          kind: "metered",
          included: 2000,
          overage: "bill",
          resets: "month",
          carryOver: false,
        },
        seats: {
          feature: "seats",
          kind: "metered",
          included: 5,
          overage: "block",
          resets: "never",
          carryOver: false,
        },
      });
    }),
  );

  it.effect("returns null for a tier or feature the catalog does not carry", () =>
    Effect.gen(function* () {
      const built = yield* catalog(valid);
      expect(tierOf(built, "missing")).toBe(null);
      expect(featureOf(built, "missing")).toBe(null);
      expect(allowancesOf(built, "missing")).toBe(null);
    }),
  );

  it("exposes every refusal as one tagged union", () => {
    expect(Schema.is(CatalogError)(new CatalogDuplicateTier({ tier: "pro" }))).toBe(true);
    expect(
      Schema.is(CatalogError)(new CatalogUnlimitedOverage({ tier: "pro", feature: "x" })),
    ).toBe(true);
    expect(Schema.is(CatalogError)(new CatalogFlagNotGranted({ tier: "pro", feature: "x" }))).toBe(
      true,
    );
    expect(Schema.is(CatalogError)(new CatalogCarryOverOnFlag({ tier: "pro", feature: "x" }))).toBe(
      true,
    );
    expect(
      Schema.is(CatalogError)(new CatalogCarryOverNeverResets({ tier: "pro", feature: "x" })),
    ).toBe(true);
    expect(Schema.is(CatalogError)(new Error("not a catalog error"))).toBe(false);
  });

  it("accepts a carrying allowance, and refuses a carry that cannot happen", () => {
    const carrying = tier({
      id: "carrying",
      grants: [allowance(messages, { included: 2_000, carryOver: true })],
    });
    const accepted = defineCatalog({ features: [messages], tiers: [carrying] });
    expect(Result.isSuccess(accepted)).toBe(true);
    if (Result.isSuccess(accepted)) {
      expect(allowancesOf(accepted.success, "carrying")?.messages?.carryOver).toBe(true);
    }

    const onFlag = tier({ id: "on_flag", grants: [{ ...grant(sso), carryOver: true }] });
    const refusedFlag = defineCatalog({ features: [messages, sso], tiers: [onFlag] });
    expect(Result.isFailure(refusedFlag)).toBe(true);
    if (Result.isFailure(refusedFlag)) {
      expect(Schema.is(CatalogCarryOverOnFlag)(refusedFlag.failure)).toBe(true);
      if (!Schema.is(CatalogCarryOverOnFlag)(refusedFlag.failure)) return;
      // Every refusal names the tier and the feature that caused it.
      expect(refusedFlag.failure.tier).toBe("on_flag");
      expect(refusedFlag.failure.feature).toBe("sso");
    }

    const never = tier({
      id: "never_resets",
      grants: [allowance(messages, { included: 10, resets: "never", carryOver: true })],
    });
    const refusedNever = defineCatalog({ features: [messages], tiers: [never] });
    expect(Result.isFailure(refusedNever)).toBe(true);
    if (Result.isFailure(refusedNever)) {
      expect(Schema.is(CatalogCarryOverNeverResets)(refusedNever.failure)).toBe(true);
      if (!Schema.is(CatalogCarryOverNeverResets)(refusedNever.failure)) return;
      expect(refusedNever.failure.tier).toBe("never_resets");
      expect(refusedNever.failure.feature).toBe("messages");
    }
  });

  it("declares a flag, and defaults every other feature to metered", () => {
    expect(sso.kind).toBe("flag");
    expect(messages.kind).toBe("metered");
    expect(feature({ id: "reports", kind: "flag" })).toEqual({ id: "reports", kind: "flag" });
  });

  it("accepts a flag granted with grant(), and refuses one given a count", () => {
    const enterprise = tier({
      id: "enterprise",
      price: { amount: 49_900, currency: "usd", interval: "month" },
      grants: [grant(sso), allowance(messages, { included: 50_000 })],
    });
    const accepted = defineCatalog({ features: [sso, messages], tiers: [enterprise] });
    expect(Result.isSuccess(accepted)).toBe(true);
    if (Result.isSuccess(accepted)) {
      expect(allowancesOf(accepted.success, "enterprise")?.sso).toEqual({
        feature: "sso",
        kind: "flag",
        included: 1,
        overage: "allow",
        resets: "never",
      });
    }

    // A count, a shorter reset or a blocking overage all describe a counter a
    // flag does not have.
    for (const counted of [
      allowance(sso, { included: 100 }),
      allowance(sso, { included: 1, overage: "block" }),
      allowance(sso, { included: 1 }),
    ]) {
      const refused = defineCatalog({
        features: [sso],
        tiers: [{ id: "sso_tier" as TierId, grants: [counted] }],
      });
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) {
        expect(refused.failure).toBeInstanceOf(CatalogFlagNotGranted);
        if (refused.failure._tag !== "CatalogFlagNotGranted") return;
        // The refusal names the tier and the feature, so an operator can find it.
        expect(refused.failure.tier).toBe("sso_tier");
        expect(refused.failure.feature).toBe("sso");
      }
    }
  });

  it("accepts an unlimited allowance and defaults its overage to allow", () => {
    expect(allowance(messages, { included: "unlimited" })).toEqual({
      feature: "messages",
      kind: "metered",
      included: "unlimited",
      overage: "allow",
      resets: "month",
      carryOver: false,
    });
    const unlimited = tier({
      id: "unlimited",
      grants: [allowance(messages, { included: "unlimited" })],
    });
    const result = defineCatalog({ features: [messages], tiers: [unlimited] });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(allowancesOf(result.success, "unlimited")?.messages?.included).toBe("unlimited");
    }
  });

  it("refuses a block or bill overage beside an unlimited allowance", () => {
    for (const overage of ["block", "bill"] as const) {
      const contradictory = tier({
        id: "contradictory",
        grants: [allowance(messages, { included: "unlimited", overage })],
      });
      const result = defineCatalog({ features: [messages], tiers: [contradictory] });
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(CatalogUnlimitedOverage);
        if (result.failure._tag !== "CatalogUnlimitedOverage") return;
        // The refusal names the feature, so an operator can find the grant.
        expect(result.failure.feature).toBe("messages");
        expect(result.failure.tier).toBe("contradictory");
      }
    }
  });

  it("accepts a credit-priced feature and a tier that sells a pool", () => {
    const creditsTier = tier({
      id: "credits",
      price: { amount: 9_900, currency: "usd", interval: "month" },
      credits: 50_000,
      grants: [allowance(messages, { included: 100 })],
    });
    const result = defineCatalog({ features: [messages, ai], tiers: [creditsTier] });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(featureOf(result.success, "ai")?.creditRates).toEqual({ default: 1, "gpt-large": 10 });
      expect(tierOf(result.success, "credits")?.credits).toBe(50_000);
    }
  });

  it("refuses a rate card with no default, and a rate that is not positive", () => {
    const missing = defineCatalog({
      features: [feature({ id: "ai", creditRates: { "gpt-large": 10 } })],
      tiers: [],
    });
    expect(Result.isFailure(missing)).toBe(true);
    if (Result.isFailure(missing)) {
      expect(Schema.is(CatalogCreditRateMissing)(missing.failure)).toBe(true);
      if (!Schema.is(CatalogCreditRateMissing)(missing.failure)) return;
      expect(missing.failure.feature).toBe("ai");
    }

    for (const rate of [0, -1]) {
      const invalid = defineCatalog({
        features: [feature({ id: "ai", creditRates: { default: 1, "gpt-large": rate } })],
        tiers: [],
      });
      expect(Result.isFailure(invalid)).toBe(true);
      if (Result.isFailure(invalid)) {
        expect(Schema.is(CatalogCreditRateInvalid)(invalid.failure)).toBe(true);
        if (!Schema.is(CatalogCreditRateInvalid)(invalid.failure)) return;
        expect(invalid.failure.feature).toBe("ai");
        expect(invalid.failure.dimension).toBe("gpt-large");
      }
    }
  });

  it("refuses an allowance for a credit-priced feature, or a rate card on a flag", () => {
    const counted = tier({ id: "counted", grants: [allowance(ai, { included: 100 })] });
    const withAllowance = defineCatalog({ features: [ai], tiers: [counted] });
    expect(Result.isFailure(withAllowance)).toBe(true);
    if (Result.isFailure(withAllowance)) {
      expect(Schema.is(CatalogCreditFeatureHasAllowance)(withAllowance.failure)).toBe(true);
      if (!Schema.is(CatalogCreditFeatureHasAllowance)(withAllowance.failure)) return;
      expect(withAllowance.failure.tier).toBe("counted");
      expect(withAllowance.failure.feature).toBe("ai");
    }

    const flagged = feature({ id: "sso", kind: "flag", creditRates: { default: 1 } });
    const onFlag = defineCatalog({
      features: [flagged],
      tiers: [tier({ id: "flagged", grants: [grant(flagged)] })],
    });
    expect(Result.isFailure(onFlag)).toBe(true);
    if (Result.isFailure(onFlag)) {
      expect(Schema.is(CatalogCreditRatesOnFlag)(onFlag.failure)).toBe(true);
      if (!Schema.is(CatalogCreditRatesOnFlag)(onFlag.failure)) return;
      expect(onFlag.failure.feature).toBe("sso");
    }
  });

  it("refuses a credit grant that is negative or expires with nothing to expire", () => {
    for (const bad of [
      tier({ id: "negative", credits: -1, grants: [allowance(messages, { included: 1 })] }),
      tier({ id: "empty", creditsExpire: "never", grants: [allowance(messages, { included: 1 })] }),
    ]) {
      const result = defineCatalog({ features: [messages], tiers: [bad] });
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(Schema.is(CatalogCreditGrantInvalid)(result.failure)).toBe(true);
        if (!Schema.is(CatalogCreditGrantInvalid)(result.failure)) return;
        expect(result.failure.tier).toBe(bad.id);
      }
    }
  });

  it("accepts a one-off credit pack, and refuses the shapes that are not one", () => {
    const pack = tier({
      id: "credits_1m",
      kind: "one_off",
      price: { amount: 9_900, currency: "usd", interval: "month" },
      credits: 1_000_000,
      grants: [],
    });
    const accepted = defineCatalog({ features: [messages], tiers: [pack] });
    expect(Result.isSuccess(accepted)).toBe(true);
    if (Result.isSuccess(accepted)) {
      const declared = tierOf(accepted.success, "credits_1m");
      expect(declared?.kind).toBe("one_off");
      // The constructor defaults a pack's credits to never expiring.
      expect(declared?.creditsExpire).toBe("never");
    }

    const refusal = (candidate: ReturnType<typeof tier>) => {
      const result = defineCatalog({ features: [messages], tiers: [candidate] });
      return Result.isFailure(result) ? result.failure : null;
    };

    expect(
      refusal(
        tier({
          id: "granting_pack",
          kind: "one_off",
          price: { amount: 100, currency: "usd", interval: "month" },
          credits: 10,
          grants: [allowance(messages, { included: 1 })],
        }),
      ),
    ).toBeInstanceOf(CatalogOneOffGrant);

    expect(
      refusal(
        tier({
          id: "empty_pack",
          kind: "one_off",
          price: { amount: 100, currency: "usd", interval: "month" },
          grants: [],
        }),
      ),
    ).toBeInstanceOf(CatalogOneOffCredits);

    expect(
      refusal(
        tier({
          id: "expiring_pack",
          kind: "one_off",
          price: { amount: 100, currency: "usd", interval: "month" },
          credits: 10,
          creditsExpire: "period",
          grants: [],
        }),
      ),
    ).toBeInstanceOf(CatalogOneOffCreditsExpire);

    expect(
      refusal(tier({ id: "free_pack", kind: "one_off", credits: 10, grants: [] })),
    ).toBeInstanceOf(CatalogOneOffWithoutPrice);
  });

  it("accepts a postpaid unit price, and refuses a price or cap that cannot be billed", () => {
    const metered = tier({
      id: "metered",
      price: { amount: 1_900, currency: "usd", interval: "month" },
      grants: [
        allowance(messages, {
          included: 100,
          overage: "bill",
          unitPrice: { amount: 2, currency: "usd" },
          moneyCap: 500,
        }),
      ],
    });
    expect(Result.isSuccess(defineCatalog({ features: [messages], tiers: [metered] }))).toBe(true);

    const refusal = (candidate: ReturnType<typeof tier>) => {
      const result = defineCatalog({ features: [messages], tiers: [candidate] });
      return Result.isFailure(result) ? result.failure : null;
    };

    expect(
      refusal(
        tier({
          id: "unbilled",
          grants: [
            allowance(messages, {
              included: 100,
              unitPrice: { amount: 2, currency: "usd" },
            }),
          ],
        }),
      ),
    ).toBeInstanceOf(CatalogUnitPriceWithoutBilling);

    expect(
      refusal(
        tier({
          id: "no_price",
          grants: [allowance(messages, { included: 100, overage: "bill", moneyCap: 500 })],
        }),
      ),
    ).toBeInstanceOf(CatalogMoneyCapWithoutUnitPrice);

    expect(
      refusal(
        tier({
          id: "currency_mismatch",
          price: { amount: 1_900, currency: "usd", interval: "month" },
          grants: [
            allowance(messages, {
              included: 100,
              overage: "bill",
              unitPrice: { amount: 2, currency: "eur" },
            }),
          ],
        }),
      ),
    ).toBeInstanceOf(CatalogUnitPriceCurrency);
  });

  it("rejects a feature declared twice", () => {
    const result = defineCatalog({ features: [messages, messages], tiers: [free] });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(CatalogDuplicateFeature);
    }
  });

  it("rejects a tier declared twice", () => {
    const result = defineCatalog({ features: [messages], tiers: [free, free] });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(CatalogDuplicateTier);
    }
  });

  it("rejects a tier that quotes the same feature twice", () => {
    const twice = tier({
      id: "twice",
      grants: [allowance(messages, { included: 1 }), allowance(messages, { included: 2 })],
    });
    const result = defineCatalog({ features: [messages], tiers: [twice] });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(CatalogDuplicateAllowance);
    }
  });

  it("rejects a grant for a feature the catalog never declared", () => {
    const ghost = feature({ id: "ghost" });
    const haunted = tier({
      id: "haunted",
      grants: [allowance(ghost, { included: 1 })],
    });
    const result = defineCatalog({ features: [messages], tiers: [haunted] });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(CatalogUnknownFeature);
    }
  });

  it("rejects a tier with no grants", () => {
    const empty = { id: "empty" as TierId, grants: [] };
    const result = defineCatalog({ features: [messages], tiers: [empty] });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(CatalogEmptyTier);
    }
  });

  it("rejects a negative allowance at the schema boundary", () => {
    const negative = tier({
      id: "negative",
      grants: [allowance(messages, { included: -1 })],
    });
    const result = defineCatalog({ features: [messages], tiers: [negative] });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(CatalogInvalid);
    }
  });

  it("rejects a price that is not positive whole minor units", () => {
    const freebie = tier({
      id: "freebie",
      price: { amount: 0, currency: "usd", interval: "month" },
      grants: [allowance(messages, { included: 1 })],
    });
    const result = defineCatalog({ features: [messages], tiers: [freebie] });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(CatalogInvalid);
    }
  });

  it("rejects an empty feature id", () => {
    const unnamed = feature({ id: "" });
    const result = defineCatalog({ features: [unnamed], tiers: [] });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(CatalogInvalid);
    }
  });
});
