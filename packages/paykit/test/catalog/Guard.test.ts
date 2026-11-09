import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { planItemsOf, catalog, creditTermsOf } from "../../src/Catalog.ts";
import { catalogMismatchOf } from "../../src/CatalogGuard.ts";
import { messages } from "../../src/Feature.ts";
import { tier } from "../../src/Tier.ts";

const freeTier = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });

const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  topUp: { threshold: 500 },
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});

const supportTier = tier({
  id: "support",
  group: "support",
  addOn: true,
  grants: [allowance(messages, { included: 5, overage: "block" })],
});

const ceilTier = tier({
  id: "ceil",
  price: { amount: 4900, currency: "usd", interval: "month" },
  grants: [
    allowance(messages, {
      included: 100,
      overage: "bill",
      cap: 1_000,
      unitPrice: { amount: 2, currency: "usd" },
      moneyCap: 5_000,
    }),
  ],
});

const testCatalog = Effect.runSync(
  catalog({ features: [messages], tiers: [freeTier, proTier, supportTier, ceilTier] }),
);

const free = planItemsOf(testCatalog, "free")!;
const pro = planItemsOf(testCatalog, "pro")!;
const ceil = planItemsOf(testCatalog, "ceil")!;
const support = planItemsOf(testCatalog, "support")!;
const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const ceilPrice = { amount: 4900, currency: "usd", interval: "month" as const };
const proTerms = creditTermsOf(testCatalog, "pro")!;
const freeTerms = creditTermsOf(testCatalog, "free")!;
const supportTerms = creditTermsOf(testCatalog, "support")!;

describe("the catalog guard", () => {
  it("accepts a command whose fields match the catalog", () => {
    expect(
      catalogMismatchOf(testCatalog, {
        tier: "pro",
        allowances: pro,
        price: proPrice,
        ...proTerms,
      }),
    ).toBe(null);
    // A free tier carries no price and no top-up line, and that matches.
    expect(catalogMismatchOf(testCatalog, { tier: "free", allowances: free, ...freeTerms })).toBe(
      null,
    );
    // A grouped add-on carries its group and flag as plan terms.
    expect(
      catalogMismatchOf(testCatalog, {
        tier: "support",
        group: "support",
        addOn: true,
        allowances: support,
        ...supportTerms,
      }),
    ).toBe(null);
  });

  it("refuses a group or add-on flag the catalog does not state", () => {
    const grouped = catalogMismatchOf(testCatalog, {
      tier: "support",
      group: "other",
      addOn: true,
      allowances: support,
      ...supportTerms,
    });

    const forged = catalogMismatchOf(testCatalog, {
      tier: "support",
      group: "support",
      addOn: false,
      allowances: support,
      ...supportTerms,
    });

    expect(grouped?.field).toBe("group");
    expect(forged?.field).toBe("addOn");
  });

  it("refuses credit terms the catalog never sold", () => {
    // The pool, its expiry and the rate cards decide what a request costs, so
    // a command that claims different ones never reaches `decide`.
    const pool = catalogMismatchOf(testCatalog, {
      tier: "pro",
      allowances: pro,
      price: proPrice,
      credits: proTerms.credits + 1,
      creditsExpire: proTerms.creditsExpire,
      topUp: proTerms.topUp,
      rates: proTerms.rates,
    });

    expect(pool?.field).toBe("credits");

    const expiry = catalogMismatchOf(testCatalog, {
      tier: "pro",
      allowances: pro,
      price: proPrice,
      credits: proTerms.credits,
      creditsExpire: "never",
      topUp: proTerms.topUp,
      rates: proTerms.rates,
    });

    expect(expiry?.field).toBe("creditsExpire");

    const rates = catalogMismatchOf(testCatalog, {
      tier: "pro",
      allowances: pro,
      price: proPrice,
      credits: proTerms.credits,
      creditsExpire: proTerms.creditsExpire,
      topUp: proTerms.topUp,
      rates: { messages: { default: 1 } },
    });

    expect(rates?.field).toBe("rates");
  });

  it("refuses a top-up line the catalog never sold", () => {
    const moved = catalogMismatchOf(testCatalog, {
      tier: "pro",
      allowances: pro,
      price: proPrice,
      ...proTerms,
      topUp: { threshold: 1_000 },
    });

    expect(moved?.field).toBe("topUp");

    const omitted = catalogMismatchOf(testCatalog, {
      tier: "pro",
      allowances: pro,
      price: proPrice,
      credits: proTerms.credits,
      creditsExpire: proTerms.creditsExpire,
      rates: proTerms.rates,
    });

    expect(omitted?.field).toBe("topUp");

    const freeClaim = catalogMismatchOf(testCatalog, {
      tier: "free",
      allowances: free,
      topUp: { threshold: 500 },
    });

    expect(freeClaim?.field).toBe("topUp");
  });

  it("refuses a tier the catalog does not carry", () => {
    const mismatch = catalogMismatchOf(testCatalog, { tier: "enterprise" });
    expect(mismatch?._tag).toBe("CatalogMismatch");
    expect(mismatch?.field).toBe("tier");
  });

  it("refuses a priced tier whose price was omitted on the wire", () => {
    const mismatch = catalogMismatchOf(testCatalog, { tier: "pro", allowances: pro });
    expect(mismatch?.field).toBe("price");
    expect(mismatch?.expected).toContain("1900");
    expect(mismatch?.actual).toBe("free");
  });

  it("refuses a price that disagrees with the catalog", () => {
    const mismatch = catalogMismatchOf(testCatalog, {
      tier: "pro",
      allowances: pro,
      price: { amount: 100, currency: "usd", interval: "month" },
    });

    expect(mismatch?.field).toBe("price");
  });

  it("refuses allowances the tier does not grant", () => {
    const mismatch = catalogMismatchOf(testCatalog, {
      tier: "pro",
      allowances: free,
      price: proPrice,
    });

    expect(mismatch?.field).toBe("allowances");
  });

  it("refuses a ceiling or price the catalog never sold", () => {
    const granted = ceil.messages!;
    const terms = creditTermsOf(testCatalog, "ceil")!;

    const carries = (messages: typeof granted) =>
      catalogMismatchOf(testCatalog, {
        tier: "ceil",
        allowances: { messages },
        price: ceilPrice,
        ...terms,
      });

    // A higher unit ceiling, a different unit price and a different money
    // ceiling are all money the deploy never agreed to. Each must be named.
    expect(carries({ ...granted, cap: granted.cap! + 1 })?.field).toBe("allowances");
    expect(carries({ ...granted, unitPrice: { ...granted.unitPrice!, amount: 3 } })?.field).toBe(
      "allowances",
    );
    expect(carries({ ...granted, moneyCap: granted.moneyCap! + 1 })?.field).toBe("allowances");
    // And the unmutated terms still pass, so the key is not over-strict.
    expect(carries(granted)).toBe(null);
  });

  it("accepts a free tier given an explicit absence of price", () => {
    expect(catalogMismatchOf(testCatalog, { tier: "free", allowances: free })).toBe(null);
  });

  it("refuses a free tier that claims a price", () => {
    const mismatch = catalogMismatchOf(testCatalog, {
      tier: "free",
      allowances: free,
      price: proPrice,
    });

    expect(mismatch?.field).toBe("price");
  });

  it("ignores a command that carries no catalog field", () => {
    expect(catalogMismatchOf(testCatalog, {})).toBe(null);
  });
});

it("the guard is a Layer that needs the catalog", () => {
  // The Layer's requirement is the point: a guard that cannot read the
  // catalog must not be built, let alone run.
  expect(typeof Layer.build).toBe("function");
  expect(Effect.isEffect(Effect.void)).toBe(true);
});
