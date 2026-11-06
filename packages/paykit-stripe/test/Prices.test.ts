import { describe, expect, it } from "@alchemy.run/test";
import { lookupKeyOf, priceDeclarations, retiredPrices, soldTiers } from "../src/Prices.ts";

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
        seats: [],
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
        seats: [],
      },
    ]);
  });

  it("declares a recurring seat price for each non-consumable feature", () => {
    const [declaration] = priceDeclarations(
      {
        pro: {
          price: pro,
          seats: { seats: { amount: 1_000, currency: "usd" } },
        },
      },
      stage,
    );
    expect(declaration?.seats).toEqual([
      {
        feature: "seats",
        unitPrice: { amount: 1_000, currency: "usd" },
        priceResource: "Price_pro_Seat_seats",
        lookupKey: "paykit:prod:pro:seat:seats",
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

  it("declares a package price with its units, so the deploy can transform the meter", () => {
    const [declaration] = priceDeclarations(
      {
        pro: {
          price: pro,
          usage: { messages: { kind: "unit", amount: 500, currency: "usd", units: 1_000 } },
        },
      },
      stage,
    );
    expect(declaration?.usage[0]?.unitPrice).toEqual({
      amount: 500,
      currency: "usd",
      units: 1_000,
    });
  });

  it("declares a ladder as its full pricing, because no single rate names it", () => {
    const [declaration] = priceDeclarations(
      {
        pro: {
          price: pro,
          usage: {
            messages: {
              kind: "graduated",
              currency: "usd",
              bands: [
                { upTo: 100, amount: 1, currency: "usd" },
                { upTo: "inf", amount: 2, currency: "usd" },
              ],
            },
          },
        },
      },
      stage,
    );
    expect(declaration?.usage[0]?.unitPrice).toBe(undefined);
    expect(declaration?.usage[0]?.pricing).toEqual({
      _tag: "graduated",
      currency: "usd",
      bands: [
        { upTo: 100, unitPrice: { amount: 1, currency: "usd" } },
        { upTo: "inf", unitPrice: { amount: 2, currency: "usd" } },
      ],
    });
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

describe("the archive sweep", () => {
  const declared = priceDeclarations(
    { pro: { price: pro, usage: { messages: { amount: 2, currency: "usd" } } } },
    stage,
  );

  it("names a base price whose tier left the catalog, and nothing else", () => {
    const retired = retiredPrices(
      declared,
      [
        { id: "price_pro", lookupKey: "paykit:prod:pro", active: true },
        { id: "price_scale", lookupKey: "paykit:prod:scale", active: true },
      ],
      stage,
    );
    expect(retired.map((price) => price.id)).toEqual(["price_scale"]);
  });

  it("names a metered price whose feature left the tier", () => {
    // The tier is still sold, so its base price stays; the feature behind the
    // meter is gone, so the metered price is the one to archive.
    const retired = retiredPrices(
      declared,
      [
        { id: "price_pro", lookupKey: "paykit:prod:pro", active: true },
        { id: "price_msg", lookupKey: "paykit:prod:pro:usage:messages", active: true },
        { id: "price_seats", lookupKey: "paykit:prod:pro:usage:seats", active: true },
      ],
      stage,
    );
    expect(retired.map((price) => price.id)).toEqual(["price_seats"]);
  });

  it("leaves another stage's prices alone, even though they share one account", () => {
    const retired = retiredPrices(
      declared,
      [{ id: "price_preview", lookupKey: "paykit:preview:pro", active: true }],
      stage,
    );
    expect(retired).toEqual([]);
  });

  it("is idempotent: an archived price is not named a second time", () => {
    const found = [{ id: "price_scale", lookupKey: "paykit:prod:scale", active: false }];
    expect(retiredPrices(declared, found, stage)).toEqual([]);
  });

  it("leaves a price with no lookup key alone: it is not this library's", () => {
    const retired = retiredPrices(
      declared,
      [{ id: "price_manual", lookupKey: null, active: true }],
      stage,
    );
    expect(retired).toEqual([]);
  });

  it("does not read `prod` as a prefix of `production`", () => {
    const retired = retiredPrices(
      declared,
      [{ id: "price_other", lookupKey: "paykit:production:pro", active: true }],
      stage,
    );
    expect(retired).toEqual([]);
  });
});

describe("sold tiers", () => {
  it("joins the keys StripePrices created back onto the catalog prices", () => {
    const sold = {
      prices: { pro: "paykit:prod:pro" },
      usage: { pro: { messages: "paykit:prod:pro:usage:messages" } },
      seats: {},
      meters: { messages: "paykit_prod_messages" },
    };
    const unitPrice = { amount: 2, currency: "usd" };
    expect(soldTiers({ pro: { price: pro, usage: { messages: unitPrice } } }, sold)).toEqual({
      pro: {
        price: pro,
        lookupKey: "paykit:prod:pro",
        usage: {
          messages: { unitPrice, lookupKey: "paykit:prod:pro:usage:messages" },
        },
      },
    });
  });

  it("joins the seat price keys back onto the catalog prices", () => {
    const sold = {
      prices: { pro: "paykit:prod:pro" },
      usage: {},
      seats: { pro: { seats: "paykit:prod:pro:seat:seats" } },
      meters: {},
    };
    const unitPrice = { amount: 1_000, currency: "usd" };
    expect(soldTiers({ pro: { price: pro, seats: { seats: unitPrice } } }, sold)).toEqual({
      pro: {
        price: pro,
        lookupKey: "paykit:prod:pro",
        seats: {
          seats: { unitPrice, lookupKey: "paykit:prod:pro:seat:seats" },
        },
      },
    });
  });

  it("joins a banded price's pricing back onto the catalog prices", () => {
    const sold = {
      prices: { pro: "paykit:prod:pro" },
      usage: { pro: { messages: "paykit:prod:pro:usage:messages" } },
      seats: {},
      meters: { messages: "paykit_prod_messages" },
    };
    const pricing = {
      _tag: "volume" as const,
      currency: "usd",
      bands: [
        { upTo: 100, unitPrice: { amount: 1, currency: "usd" } },
        { upTo: "inf" as const, unitPrice: { amount: 2, currency: "usd" } },
      ] as const,
    };
    const joined = soldTiers({ pro: { price: pro, usage: { messages: pricing } } }, sold);
    expect(joined.pro?.usage?.messages).toEqual({
      pricing,
      lookupKey: "paykit:prod:pro:usage:messages",
    });
  });

  it("omits the usage map when a tier has no billable feature", () => {
    const sold = { prices: { pro: "paykit:prod:pro" }, usage: {}, seats: {}, meters: {} };
    expect(soldTiers({ pro }, sold)).toEqual({
      pro: { price: pro, lookupKey: "paykit:prod:pro" },
    });
  });
});
