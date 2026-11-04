import { describe, expect, it } from "@alchemy.run/test";
import { lookupKeyOf, priceDeclarations } from "../src/Prices.ts";

const pro = { amount: 1900, currency: "usd", interval: "month" as const };
const scale = { amount: 19_800, currency: "usd", interval: "annual" as const };

/**
 * Only the pure half is tested here. `StripePrices` itself yields two Alchemy
 * resources per tier, which needs the engine and a Stripe account; its job is to
 * hand these declarations to `@alchemy.run/stripe`, which those resources already
 * test.
 */
describe("price declarations", () => {
  it("derives a stable lookup key per tier, not per price", () => {
    expect(lookupKeyOf("pro")).toBe("paykit:pro");
    // The key names the tier, so a replaced price keeps the same identity.
    const [first] = priceDeclarations({ pro });
    expect(first?.lookupKey).toBe("paykit:pro");
  });

  it("reads the catalog's annual interval as Stripe's year", () => {
    const [declaration] = priceDeclarations({ scale });
    expect(declaration?.interval).toBe("year");
    expect(priceDeclarations({ pro })[0]?.interval).toBe("month");
  });

  it("orders by tier id, so a catalog written two ways deploys the same way", () => {
    const forward = priceDeclarations({ pro, scale });
    const backward = priceDeclarations({ scale, pro });
    expect(forward.map((declaration) => declaration.tier)).toEqual(["pro", "scale"]);
    expect(backward).toEqual(forward);
  });

  it("carries the amount and currency the catalog states, and nothing else", () => {
    expect(priceDeclarations({ pro, scale })).toEqual([
      {
        tier: "pro",
        productResource: "Product_pro",
        priceResource: "Price_pro",
        lookupKey: "paykit:pro",
        amount: 1900,
        currency: "usd",
        interval: "month",
      },
      {
        tier: "scale",
        productResource: "Product_scale",
        priceResource: "Price_scale",
        lookupKey: "paykit:scale",
        amount: 19_800,
        currency: "usd",
        interval: "year",
      },
    ]);
  });

  it("declares nothing for a catalog with no prices", () => {
    expect(priceDeclarations({})).toEqual([]);
  });
});
