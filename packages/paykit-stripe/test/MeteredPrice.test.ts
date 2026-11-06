import * as Stripe from "@alchemy.run/stripe";
import { describe, expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { pricing } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import {
  MeteredPrice,
  registerMeteredPriceProvider,
  stripeTiersOf,
  stripeTransformOf,
} from "../src/MeteredPrice.ts";

describe("a metered price that is not one rate", () => {
  it("turns a package into the quantity transform Stripe applies before billing", () => {
    expect(
      stripeTransformOf(pricing({ kind: "unit", amount: 500, currency: "usd", units: 1_000 })),
    ).toEqual({ divide_by: 1_000, round: "up" });
    expect(
      stripeTiersOf(pricing({ kind: "unit", amount: 500, currency: "usd", units: 1_000 })),
    ).toEqual([]);
  });

  it("turns a ladder into tiers, keeping a band's package as a per-unit decimal", () => {
    const value = pricing({
      kind: "graduated",
      currency: "usd",
      bands: [
        { upTo: 100, amount: 1, currency: "usd" },
        { upTo: "inf", amount: 500, currency: "usd", units: 1_000 },
      ],
    });
    expect(stripeTransformOf(value)).toBe(undefined);
    expect(stripeTiersOf(value)).toEqual([
      { up_to: 100, unit_amount: 1 },
      { up_to: "inf", unit_amount_decimal: "0.5" },
    ]);
  });

  it("turns a volume ladder into a volume price", () => {
    const value = pricing({
      kind: "volume",
      currency: "usd",
      bands: [
        { upTo: 100, amount: 1, currency: "usd" },
        { upTo: "inf", amount: 2, currency: "usd" },
      ],
    });
    expect(stripeTiersOf(value)).toEqual([
      { up_to: 100, unit_amount: 1 },
      { up_to: "inf", unit_amount: 2 },
    ]);
  });
});

const { test } = Test.make({ providers: Stripe.providers() });

test.provider("registers its provider with an existing Stripe provider collection", () =>
  Effect.gen(function* () {
    yield* registerMeteredPriceProvider;
    const collection = yield* Stripe.Providers;
    expect(collection.get(MeteredPrice.Type)).toBeDefined();
  }),
);
