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

  it("encodes each part, so a separator inside one cannot forge another identity", () => {
    // `a` + `b:c` and `a:b` + `c` would otherwise produce the same key, and a
    // deploy could reconcile the wrong tier's price.
    expect(lookupKeyOf("a", "b:c")).not.toBe(lookupKeyOf("a:b", "c"));
    expect(lookupKeyOf("a%3Ab", "c")).not.toBe(lookupKeyOf("a", "b:c"));
    expect(lookupKeyOf("preview 1", "pro")).toBe("paykit:preview_20_1:pro");
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
        kind: "subscription",
        productResource: "Product_pro",
        priceResource: "Price_pro",
        lookupKey: "paykit:prod:pro",
        amount: 1900,
        currency: "usd",
        interval: "month",
        usage: [],
      },
      {
        tier: "scale",
        kind: "subscription",
        productResource: "Product_scale",
        priceResource: "Price_scale",
        lookupKey: "paykit:prod:scale",
        amount: 19_800,
        currency: "usd",
        interval: "year",
        usage: [],
      },
    ]);
  });

  it("declares a meter and a metered price for each billable feature", () => {
    const usage = { amount: 2, currency: "usd" } as const;
    const [declaration] = priceDeclarations(
      { pro: { price: pro, usage: { messages: usage, seats: { amount: 5, currency: "usd" } } } },
      stage,
    );
    expect(declaration?.usage).toEqual([
      {
        feature: "messages",
        unitPrice: usage,
        meterResource: "Meter_messages",
        priceResource: "Price_pro_Usage_messages",
        eventName: "paykit_prod_messages",
        lookupKey: "paykit:prod:pro:usage:messages",
      },
      {
        feature: "seats",
        unitPrice: { amount: 5, currency: "usd" },
        meterResource: "Meter_seats",
        priceResource: "Price_pro_Usage_seats",
        eventName: "paykit_prod_seats",
        lookupKey: "paykit:prod:pro:usage:seats",
      },
    ]);
  });

  it("keeps a feature's meter name stable across tiers, and its metered key per tier", () => {
    const usage = { amount: 2, currency: "usd" } as const;
    const declarations = priceDeclarations(
      {
        pro: { price: pro, usage: { messages: usage } },
        scale: { price: scale, usage: { messages: usage } },
      },
      stage,
    );
    expect(declarations[0]?.usage[0]?.eventName).toBe(declarations[1]?.usage[0]?.eventName);
    expect(declarations[0]?.usage[0]?.lookupKey).not.toBe(declarations[1]?.usage[0]?.lookupKey);
  });

  it("marks a one-off pack as one-time, so the price is not recurring", () => {
    const [declaration] = priceDeclarations({ credits: { price: pro, kind: "one_off" } }, stage);
    expect(declaration?.kind).toBe("one_off");
    // The row still carries the catalog's interval; the resource uses `kind`
    // to decide whether to send it as a recurring price.
    expect(declaration?.amount).toBe(1900);
  });

  it("declares nothing for a catalog with no prices", () => {
    expect(priceDeclarations({}, stage)).toEqual([]);
  });
});
