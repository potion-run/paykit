import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { allowance } from "../src/Allowance.ts";
import {
  CatalogDuplicateAllowance,
  CatalogDuplicateFeature,
  CatalogDuplicateTier,
  CatalogEmptyTier,
  CatalogError,
  CatalogInvalid,
  CatalogUnknownFeature,
  allowancesOf,
  catalog,
  defineCatalog,
  featureOf,
  tierOf,
} from "../src/Catalog.ts";
import { feature, messages } from "../src/Feature.ts";
import { TierId, tier } from "../src/Tier.ts";

const seats = feature({ id: "seats", name: "Seats" });

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
      included: 100,
      overage: "block",
      resets: "month",
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
          included: 2000,
          overage: "bill",
          resets: "month",
        },
        seats: {
          feature: "seats",
          included: 5,
          overage: "block",
          resets: "never",
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
    expect(Schema.is(CatalogError)(new Error("not a catalog error"))).toBe(false);
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
