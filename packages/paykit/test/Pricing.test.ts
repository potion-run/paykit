import { describe, expect, it } from "@alchemy.run/test";
import { asPricing, pricing, pricingKey, unitAmountDecimalOf } from "../src/Pricing.ts";

describe("reading a pricing a provider or a catalog writes", () => {
  it("accepts the one-rate shorthand, the authoring input and the normalized value", () => {
    expect(asPricing({ amount: 2, currency: "usd" })).toEqual({
      _tag: "unit",
      unitPrice: { amount: 2, currency: "usd" },
    });
    expect(
      asPricing({
        kind: "unit",
        amount: 500,
        currency: "usd",
        units: 1_000,
      }),
    ).toEqual({
      _tag: "unit",
      unitPrice: { amount: 500, currency: "usd", units: 1_000 },
    });

    const ladder = pricing({
      kind: "volume",
      currency: "usd",
      bands: [
        { upTo: 100, amount: 1, currency: "usd" },
        { upTo: "inf", amount: 2, currency: "usd" },
      ],
    });
    expect(asPricing(ladder)).toBe(ladder);
  });

  it("keeps a package's size in its identity", () => {
    const one = pricing({ kind: "unit", amount: 500, currency: "usd" });
    const thousand = pricing({ kind: "unit", amount: 500, currency: "usd", units: 1_000 });
    expect(pricingKey(one)).not.toBe(pricingKey(thousand));
  });
});

describe("a package as a per-unit decimal", () => {
  it("states the amount one unit costs for a vendor that prices units", () => {
    expect(unitAmountDecimalOf({ amount: 500, currency: "usd", units: 1_000 })).toBe("0.5");
    expect(unitAmountDecimalOf({ amount: 500, currency: "usd" })).toBe("500");
    expect(unitAmountDecimalOf({ amount: 100, currency: "usd", units: 4 })).toBe("25");
  });

  it("rounds a repeating decimal to the vendor's twelve places", () => {
    expect(unitAmountDecimalOf({ amount: 1, currency: "usd", units: 3 })).toBe("0.333333333333");
  });

  it("passes through a decimal a vendor already returned", () => {
    expect(unitAmountDecimalOf({ amount: 0.5, currency: "usd" })).toBe("0.5");
  });
});
