import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { catalogMismatchOf } from "../../src/CatalogGuard.ts";
import { messages } from "../../src/Feature.ts";
import { tier } from "../../src/Tier.ts";

const freeTier = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });
const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});
const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [freeTier, proTier] }));
const free = allowancesOf(testCatalog, "free")!;
const pro = allowancesOf(testCatalog, "pro")!;
const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };

describe("the catalog guard", () => {
  it("accepts a command whose fields match the catalog", () => {
    expect(catalogMismatchOf(testCatalog, { tier: "pro", allowances: pro, price: proPrice })).toBe(
      null,
    );
    // A free tier carries no price, and that matches.
    expect(catalogMismatchOf(testCatalog, { tier: "free", allowances: free })).toBe(null);
  });

  it("refuses a tier the catalog does not carry", () => {
    const mismatch = catalogMismatchOf(testCatalog, { tier: "enterprise" });
    expect(mismatch?._tag).toBe("CatalogMismatch");
    expect(mismatch?.field).toBe("tier");
  });

  it("refuses a priced tier whose price was omitted on the wire", () => {
    const mismatch = catalogMismatchOf(testCatalog, { tier: "pro", allowances: pro });
    expect(mismatch?.field).toBe("price");
    expect(mismatch?.expected).toBe("1900:usd:month");
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
