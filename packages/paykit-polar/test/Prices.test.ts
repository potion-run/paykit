import { describe, expect, it } from "@alchemy.run/test";
import * as Output from "alchemy/Output";
import {
  priceDeclarations,
  productNameOf,
  productNamePrefixOf,
  retiredProducts,
  soldTiers,
  type FoundProduct,
} from "../src/Prices.ts";

const pro = { amount: 1900, currency: "usd", interval: "month" as const };
const scale = { amount: 19_800, currency: "usd", interval: "annual" as const };
const stage = "prod";

describe("product declarations", () => {
  it("derives a stage-qualified name per tier, not per price", () => {
    expect(productNameOf("prod", "pro")).toBe("paykit:prod:pro");
    // The name is the tier's identity, so a replaced product keeps it.
    const [first] = priceDeclarations({ pro }, stage);
    expect(first?.name).toBe("paykit:prod:pro");
  });

  it("encodes each part, so a separator inside one cannot forge another identity", () => {
    expect(productNameOf("a", "b:c")).not.toBe(productNameOf("a:b", "c"));
    expect(productNameOf("a%3Ab", "c")).not.toBe(productNameOf("a", "b:c"));
    expect(productNameOf("preview 1", "pro")).toBe("paykit:preview_20_1:pro");
  });

  it("keeps stages apart, because they share one Polar organization", () => {
    expect(productNameOf("prod", "pro")).not.toBe(productNameOf("preview", "pro"));
    expect(priceDeclarations({ pro }, "preview")[0]?.name).toBe("paykit:preview:pro");
  });

  it("orders by tier id, so a catalog written two ways reconciles the same way", () => {
    const forward = priceDeclarations({ pro, scale }, stage);
    const backward = priceDeclarations({ scale, pro }, stage);
    expect(forward.map((declaration) => declaration.tier)).toEqual(["pro", "scale"]);
    expect(backward).toEqual(forward);
  });

  it("carries the price the catalog states, unchanged, because Polar embeds it", () => {
    expect(priceDeclarations({ pro, scale }, stage)).toEqual([
      {
        tier: "pro",
        kind: "subscription",
        productResource: "Product_pro",
        name: "paykit:prod:pro",
        price: { amount: 1900, currency: "usd", interval: "month" },
        usage: [],
        seats: [],
      },
      {
        tier: "scale",
        kind: "subscription",
        productResource: "Product_scale",
        name: "paykit:prod:scale",
        price: { amount: 19_800, currency: "usd", interval: "annual" },
        usage: [],
        seats: [],
      },
    ]);
  });

  it("declares one seat price per non-consumable feature", () => {
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
      { feature: "seats", unitPrice: { amount: 1_000, currency: "usd" } },
    ]);
  });

  it("declares one meter per billable feature, ordered by feature id", () => {
    const [declaration] = priceDeclarations(
      {
        pro: {
          price: pro,
          usage: {
            seats: { amount: 5, currency: "usd" },
            messages: { amount: 2, currency: "usd" },
          },
        },
      },
      stage,
    );
    expect(declaration?.usage).toEqual([
      {
        feature: "messages",
        unitPrice: { amount: 2, currency: "usd" },
        meterResource: "Meter_messages",
        eventName: "paykit_prod_messages",
      },
      {
        feature: "seats",
        unitPrice: { amount: 5, currency: "usd" },
        meterResource: "Meter_seats",
        eventName: "paykit_prod_seats",
      },
    ]);
  });

  it("declares a package price with its units", () => {
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
    expect(declaration?.usage[0]?.pricing).toEqual({
      _tag: "unit",
      unitPrice: { amount: 500, currency: "usd", units: 1_000 },
    });
  });

  it("declares a ladder as its full pricing", () => {
    const [declaration] = priceDeclarations(
      {
        pro: {
          price: pro,
          usage: {
            messages: {
              kind: "volume",
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
    expect(declaration?.usage[0]?.pricing?._tag).toBe("volume");
  });

  it("marks a one-off pack as one-time, so the product is not recurring", () => {
    const [declaration] = priceDeclarations({ credits: { price: pro, kind: "one_off" } }, stage);
    expect(declaration?.kind).toBe("one_off");
    expect(declaration?.name).toBe("paykit:prod:credits");
  });

  it("declares nothing for a catalog with no prices", () => {
    expect(priceDeclarations({}, stage)).toEqual([]);
  });
});

describe("the provider join", () => {
  const product = Output.literal("prod_pro");
  const sold = {
    products: { pro: product },
    meters: { messages: "paykit_prod_messages" },
    seats: { pro: { seats: { amount: 1_000, currency: "usd" } } },
  };

  it("carries the catalog price and the product the deploy created", () => {
    const mapped = soldTiers({ pro: { price: pro } }, sold).pro;
    expect(mapped?.price).toEqual(pro);
    // The product id is an Output at declaration time; `Polar()` resolves it
    // once the deploy has applied the product, not when the map is built.
    expect(mapped?.productId).toBe(product);
  });

  it("carries every metered and seat price the catalog states", () => {
    const unitPrice = { amount: 2, currency: "usd" };
    const mapped = soldTiers(
      {
        pro: {
          price: pro,
          usage: { messages: unitPrice },
          seats: { seats: { amount: 1_000, currency: "usd" } },
        },
      },
      sold,
    ).pro;
    expect(mapped?.usage).toEqual({ messages: unitPrice });
    expect(mapped?.seats).toEqual({ seats: { amount: 1_000, currency: "usd" } });
  });

  it("drops usage and seats from a one-off pack, because its product has neither", () => {
    const mapped = soldTiers(
      {
        pro: {
          price: pro,
          kind: "one_off",
          usage: { messages: { amount: 2, currency: "usd" } },
          seats: { seats: { amount: 1_000, currency: "usd" } },
        },
      },
      sold,
    ).pro;
    expect(mapped?.usage).toBe(undefined);
    expect(mapped?.seats).toBe(undefined);
  });
});

describe("the archive sweep", () => {
  const declared = priceDeclarations({ pro: { price: pro } }, stage);

  const product = (input: {
    readonly id: string;
    readonly name: string;
    readonly tier: string | null;
    readonly archived?: boolean;
  }): FoundProduct => ({ archived: false, ...input });

  it("names the product whose tier left the catalog, and nothing else", () => {
    const retired = retiredProducts(
      declared,
      [
        product({ id: "prod_pro", name: "paykit:prod:pro", tier: "pro" }),
        product({ id: "prod_scale", name: "paykit:prod:scale", tier: "scale" }),
      ],
      stage,
    );
    expect(retired.map((found) => found.id)).toEqual(["prod_scale"]);
  });

  it("leaves another stage's products alone, even though they share one organization", () => {
    const retired = retiredProducts(
      declared,
      [product({ id: "prod_preview", name: "paykit:preview:pro", tier: "pro" })],
      stage,
    );
    expect(retired).toEqual([]);
  });

  it("is idempotent: an archived product is not named a second time", () => {
    const found = [
      product({ id: "prod_scale", name: "paykit:prod:scale", tier: "scale", archived: true }),
    ];
    expect(retiredProducts(declared, found, stage)).toEqual([]);
  });

  it("leaves a product with no `paykit_tier` metadata alone: it is not this library's", () => {
    const retired = retiredProducts(
      declared,
      [product({ id: "prod_manual", name: "paykit:prod:manual", tier: null })],
      stage,
    );
    expect(retired).toEqual([]);
  });

  it("does not read `prod` as a prefix of `production`", () => {
    const retired = retiredProducts(
      declared,
      [product({ id: "prod_other", name: "paykit:production:pro", tier: "pro" })],
      stage,
    );
    expect(retired).toEqual([]);
  });

  it("scopes the prefix with a trailing colon, so a meter name never matches a tier", () => {
    // A meter is named `paykit:<stage>:meter:<feature>`, so it shares the
    // prefix; it is not a product, and the vendor's product list is what keeps
    // it out of the sweep.
    expect(productNamePrefixOf(stage)).toBe("paykit:prod:");
    expect(productNamePrefixOf("preview 1")).toBe("paykit:preview_20_1:");
  });
});
