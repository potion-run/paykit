import { describe, expect, it } from "@alchemy.run/test";
import { priceDeclarations, productNameOf } from "../src/Prices.ts";

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
      },
      {
        tier: "scale",
        kind: "subscription",
        productResource: "Product_scale",
        name: "paykit:prod:scale",
        price: { amount: 19_800, currency: "usd", interval: "annual" },
        usage: [],
      },
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

  it("marks a one-off pack as one-time, so the product is not recurring", () => {
    const [declaration] = priceDeclarations({ credits: { price: pro, kind: "one_off" } }, stage);
    expect(declaration?.kind).toBe("one_off");
    expect(declaration?.name).toBe("paykit:prod:credits");
  });

  it("declares nothing for a catalog with no prices", () => {
    expect(priceDeclarations({}, stage)).toEqual([]);
  });
});
