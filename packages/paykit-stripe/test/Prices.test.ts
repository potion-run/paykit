import { describe, expect, it } from "@alchemy.run/test";
import { lookupKeyOf, priceDeclarations } from "../src/Prices.ts";

const pro = { amount: 1900, currency: "usd", interval: "month" as const };
const scale = { amount: 19_800, currency: "usd", interval: "annual" as const };
const stage = "prod";

/**
 * Only the pure half is tested here. `StripePrices` itself yields two Alchemy
 * resources per tier, which needs the engine and a Stripe account; its job is to
 * hand these declarations to `@alchemy.run/stripe`, which those resources already
 * test.
 */
describe("price declarations", () => {
  it("derives a stable lookup key per tier, not per price", () => {
    expect(lookupKeyOf("prod", "pro")).toBe("paykit:prod:pro");
    // The key names the tier, so a replaced price keeps the same identity.
    const [first] = priceDeclarations({ pro }, stage);
    expect(first?.lookupKey).toBe("paykit:prod:pro");
  });

  it("keeps stages apart, because they share one Stripe account", () => {
    // Without the stage in the key, a preview stack's price would take the
    // lookup key from production's and change what a live checkout charges.
    expect(lookupKeyOf("prod", "pro")).not.toBe(lookupKeyOf("preview", "pro"));
    expect(priceDeclarations({ pro }, "preview")[0]?.lookupKey).toBe("paykit:preview:pro");
  });

  it("reads the catalog's annual interval as Stripe's year", () => {
    const [declaration] = priceDeclarations({ scale }, stage);
    expect(declaration?.interval).toBe("year");
    expect(priceDeclarations({ pro }, stage)[0]?.interval).toBe("month");
  });

  it("orders by tier id, so a catalog written two ways reconciles the same way", () => {
    const forward = priceDeclarations({ pro, scale }, stage);
    const backward = priceDeclarations({ scale, pro }, stage);
    expect(forward.map((declaration) => declaration.tier)).toEqual(["pro", "scale"]);
    expect(backward).toEqual(forward);
  });

  it("carries the amount and currency the catalog states, and nothing else", () => {
    expect(priceDeclarations({ pro, scale }, stage)).toEqual([
      {
        tier: "pro",
        productResource: "Product_pro",
        priceResource: "Price_pro",
        lookupKey: "paykit:prod:pro",
        amount: 1900,
        currency: "usd",
        interval: "month",
      },
      {
        tier: "scale",
        productResource: "Product_scale",
        priceResource: "Price_scale",
        lookupKey: "paykit:prod:scale",
        amount: 19_800,
        currency: "usd",
        interval: "year",
      },
    ]);
  });

  it("declares nothing for a catalog with no prices", () => {
    expect(priceDeclarations({}, stage)).toEqual([]);
  });
});
