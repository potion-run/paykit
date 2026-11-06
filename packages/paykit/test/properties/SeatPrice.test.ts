import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { allowance, type Allowance } from "../../src/Allowance.ts";
import { defineCatalog } from "../../src/Catalog.ts";
import { feature, messages } from "../../src/Feature.ts";
import type { ProviderDescriptor } from "../../src/Stack.ts";
import { validateProviderMappings } from "../../src/Stack.ts";
import { tier } from "../../src/Tier.ts";
import { assertProperty } from "../support/Property.ts";

const Amount = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 })));
const Included = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 })));
const CapExtra = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 })));
const Currency = Schema.Literals(["usd", "eur"]);

const seats = feature({ id: "seats", name: "Seats", kind: "non_consumable" });

/** How one tier sells a seat, and how the provider maps its price. */
const TierSpec = Schema.Struct({
  currency: Currency,
  price: Amount,
  included: Included,
  overage: Schema.Literals(["bill", "block", "allow"]),
  seatPrice: Amount,
  capExtra: Schema.optionalKey(CapExtra),
  /** Whether the provider maps a price for the tier at all. */
  sold: Schema.Boolean,
  /** How the provider's seat price compares with the catalog's. */
  mapping: Schema.Literals(["correct", "missing", "amount", "currency"]),
});
type TierSpec = typeof TierSpec.Type;

const Case = Schema.Struct({
  tiers: Schema.Array(TierSpec).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(3)),
  ),
  /** Whether the provider declares the `quantity` capability. */
  quantity: Schema.Boolean,
  /** Whether it declares any seat price map; absent is the same as empty. */
  hasSeatPrices: Schema.Boolean,
});
type Case = typeof Case.Type;

const other = (currency: "usd" | "eur"): "usd" | "eur" => (currency === "usd" ? "eur" : "usd");

const tierId = (index: number): string => `tier_${index}`;

/** A catalog whose tiers all price a seat, in the shape the spec states. */
const catalogOf = (input: Case) => {
  const tiers = input.tiers.map((spec, index) =>
    tier({
      id: tierId(index),
      price: { amount: spec.price, currency: spec.currency, interval: "month" },
      grants: [
        allowance(seats, {
          included: spec.included,
          overage: spec.overage,
          ...(spec.overage === "bill"
            ? {
                pricing: { kind: "unit" as const, amount: spec.seatPrice, currency: spec.currency },
              }
            : {}),
          ...(spec.capExtra === undefined
            ? {}
            : { cap: Math.max(1, spec.included + spec.capExtra) }),
        }),
        allowance(messages, { included: 10 }),
      ],
    }),
  );
  return defineCatalog({ features: [seats, messages], tiers });
};

/** The catalog's seat price for a tier, when the tier bills a seat. */
const seatUnitPriceOf = (input: Case, index: number) => {
  const spec = input.tiers[index]!;
  return spec.overage === "bill" ? { amount: spec.seatPrice, currency: spec.currency } : null;
};

const providerOf = (input: Case): ProviderDescriptor => {
  const prices = Object.fromEntries(
    input.tiers.flatMap((spec, index) =>
      spec.sold
        ? [
            [
              tierId(index),
              { amount: spec.price, currency: spec.currency, interval: "month" as const },
            ] as const,
          ]
        : [],
    ),
  );
  const seatPrices = Object.fromEntries(
    input.tiers.flatMap((spec, index) => {
      if (!spec.sold || seatUnitPriceOf(input, index) === null) return [];
      if (spec.mapping === "missing") return [];
      return [
        [
          tierId(index),
          {
            seats: {
              amount: spec.mapping === "amount" ? spec.seatPrice + 1 : spec.seatPrice,
              currency: spec.mapping === "currency" ? other(spec.currency) : spec.currency,
            },
          },
        ] as const,
      ];
    }),
  );
  return {
    name: "memory",
    kind: "memory",
    webhook: false,
    capabilities: ["checkout", ...(input.quantity ? (["quantity"] as const) : [])],
    ...(Object.keys(prices).length === 0 ? {} : { prices }),
    ...(input.hasSeatPrices && Object.keys(seatPrices).length > 0 ? { seatPrices } : {}),
  };
};

type ExpectedMismatch = {
  readonly tier: string;
  readonly expected: string;
  readonly actual: string;
};

/**
 * The first seat-price disagreement the provider loop must find, in catalog
 * order: only a tier the provider sells, and only a seat it bills, needs a
 * price. A capability-less provider owns no subscription quantity, so it is
 * never asked for one.
 */
const expectedMismatchOf = (input: Case): ExpectedMismatch | null => {
  if (!input.quantity) return null;
  for (const [index, spec] of input.tiers.entries()) {
    if (!spec.sold || spec.overage !== "bill") continue;
    const built = { amount: spec.seatPrice, currency: spec.currency };
    const actual =
      spec.mapping === "missing" || !input.hasSeatPrices
        ? "missing"
        : `${spec.mapping === "amount" ? spec.seatPrice + 1 : spec.seatPrice} ${
            spec.mapping === "currency" ? other(spec.currency) : spec.currency
          }`;
    if (actual === "missing" || actual !== `${built.amount} ${built.currency}`) {
      return {
        tier: tierId(index),
        expected: `${built.amount} ${built.currency}`,
        actual,
      };
    }
  }
  return null;
};

/** One tier with the shape a focused example needs. */
const single = (
  overrides: Partial<Pick<TierSpec, "sold" | "mapping">> & { quantity: boolean },
): Case => ({
  quantity: overrides.quantity,
  hasSeatPrices: true,
  tiers: [
    {
      currency: "usd",
      price: 1_900,
      included: 5,
      overage: "bill",
      seatPrice: 1_000,
      sold: overrides.sold ?? true,
      mapping: overrides.mapping ?? "correct",
    },
  ],
});

const errorTagOf = (error: { readonly _tag: string }): string => error._tag;

describe("a provider that owns the subscription quantity", () => {
  /**
   * The deploy-time rule is what stops a seat change from reaching a vendor
   * with no price to put it on. It is only asked of a provider that declares
   * `quantity`, only for a tier it sells, and only for a seat that bills;
   * everything else keeps the local proration.
   */
  it.effect("requires exactly the seat prices its capability and its catalog make necessary", () =>
    assertProperty(
      Arbitrary.schema(Case),
      (input) => {
        const catalog = catalogOf(input);
        if (Result.isFailure(catalog)) return false;
        const expected = expectedMismatchOf(input);
        const result = validateProviderMappings(catalog.success, [providerOf(input)]);

        if (expected === null) return result === null;
        if (result === null || errorTagOf(result) !== "CatalogPriceMismatch") return false;
        const mismatch = result as {
          readonly tier: string;
          readonly field: string;
          readonly expected: string;
          readonly actual: string;
        };
        return (
          mismatch.tier === expected.tier &&
          mismatch.field === "seatPrice.seats" &&
          mismatch.expected === expected.expected &&
          mismatch.actual === expected.actual
        );
      },
      { runs: 120, size: 30 },
    ),
  );

  it("does not ask a provider without the capability for a seat price", () => {
    const result = validateProviderMappings(
      Result.getOrThrow(catalogOf(single({ sold: true, mapping: "missing", quantity: false }))),
      [providerOf(single({ sold: true, mapping: "missing", quantity: false }))],
    );
    expect(result).toBe(null);
  });

  it("does not ask for a seat price on a tier the provider does not sell", () => {
    const input = single({ sold: false, mapping: "missing", quantity: true });
    const result = validateProviderMappings(Result.getOrThrow(catalogOf(input)), [
      providerOf(input),
    ]);
    // No `prices` entry means the provider does not sell the tier here, so the
    // billable seat is not its price to map — exactly as the usage rule reads.
    expect(result).toBe(null);
  });

  it("refuses a seat price that disagrees by amount or currency", () => {
    for (const mapping of ["amount", "currency"] as const) {
      const input = single({ sold: true, mapping, quantity: true });
      const result = validateProviderMappings(Result.getOrThrow(catalogOf(input)), [
        providerOf(input),
      ]);
      expect(result?._tag).toBe("CatalogPriceMismatch");
      if (result?._tag === "CatalogPriceMismatch") {
        expect(result.field).toBe("seatPrice.seats");
        expect(result.actual).not.toBe(result.expected);
      }
    }
  });
});

const SeatSpec = Schema.Struct({
  billable: Schema.Boolean,
  included: Included,
  seatPrice: Amount,
  capExtra: Schema.optionalKey(CapExtra),
});
type SeatSpec = typeof SeatSpec.Type;

/** A tier that grants one or more non-consumable features. */
const ScopeTier = Schema.Struct({
  currency: Currency,
  price: Amount,
  seats: Schema.Array(SeatSpec).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(3)),
  ),
});
type ScopeTier = typeof ScopeTier.Type;

const ScopeCase = Schema.Struct({
  tiers: Schema.Array(ScopeTier).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(3)),
  ),
  scope: Schema.Literals(["feature", "subscription"]),
  quantity: Schema.Boolean,
});
type ScopeCase = typeof ScopeCase.Type;

/** The seat features a scope case may grant, declared once for the catalog. */
const seatFeatures = ["seat_0", "seat_1", "seat_2"].map((id) =>
  feature({ id, name: id, kind: "non_consumable" }),
);

const scopeCatalogOf = (input: ScopeCase) => {
  const tiers = input.tiers.map((spec, index) =>
    tier({
      id: tierId(index),
      price: { amount: spec.price, currency: spec.currency, interval: "month" },
      grants: spec.seats.map((seat, seatIndex) =>
        allowance(seatFeatures[seatIndex]!, {
          included: seat.included,
          overage: seat.billable ? "bill" : "allow",
          ...(seat.billable
            ? {
                pricing: {
                  kind: "unit" as const,
                  amount: seat.seatPrice,
                  currency: spec.currency,
                },
              }
            : {}),
          ...(seat.capExtra === undefined
            ? {}
            : { cap: Math.max(1, seat.included + seat.capExtra) }),
        }),
      ) as [Allowance, ...Allowance[]],
    }),
  );
  return defineCatalog({ features: seatFeatures, tiers });
};

const scopeProviderOf = (input: ScopeCase): ProviderDescriptor => ({
  name: "memory",
  kind: "memory",
  webhook: false,
  capabilities: ["checkout", ...(input.quantity ? (["quantity"] as const) : [])],
  prices: Object.fromEntries(
    input.tiers.map((spec, index) => [
      tierId(index),
      { amount: spec.price, currency: spec.currency, interval: "month" as const },
    ]),
  ),
  seatPrices: Object.fromEntries(
    input.tiers.map((spec, index) => [
      tierId(index),
      Object.fromEntries(
        spec.seats.flatMap((seat, seatIndex) =>
          seat.billable
            ? [[`seat_${seatIndex}`, { amount: seat.seatPrice, currency: spec.currency }] as const]
            : [],
        ),
      ),
    ]),
  ),
  ...(input.quantity ? { seatScope: input.scope } : {}),
});

/**
 * A subscription-wide seat count is one number on the vendor's subscription, so
 * a tier with two billable seats would make the update ambiguous. The refusal
 * comes after every seat price has been checked, and a per-feature scope keeps
 * the same catalog valid.
 */
const expectedScopeMismatchOf = (input: ScopeCase) => {
  if (!input.quantity || input.scope !== "subscription") return null;
  for (const [index, spec] of input.tiers.entries()) {
    const billable = spec.seats.filter((seat) => seat.billable).length;
    if (billable > 1) return { tier: tierId(index), actual: String(billable) };
  }
  return null;
};

describe("a subscription-wide seat count", () => {
  it.effect("owns at most one billable seat feature per tier", () =>
    assertProperty(
      Arbitrary.schema(ScopeCase),
      (input) => {
        const catalog = scopeCatalogOf(input);
        if (Result.isFailure(catalog)) return false;
        const expected = expectedScopeMismatchOf(input);
        const result = validateProviderMappings(catalog.success, [scopeProviderOf(input)]);
        if (expected === null) return result === null;
        if (result === null || errorTagOf(result) !== "CatalogPriceMismatch") return false;
        const mismatch = result as {
          readonly tier: string;
          readonly field: string;
          readonly expected: string;
          readonly actual: string;
        };
        return (
          mismatch.tier === expected.tier &&
          mismatch.field === "seatPrices" &&
          mismatch.expected === "one billable seat feature" &&
          mismatch.actual === expected.actual
        );
      },
      { runs: 80, size: 30 },
    ),
  );

  it("refuses two billable seats on a subscription scope and accepts them per feature", () => {
    const twoSeats = (scope: "feature" | "subscription"): ProviderDescriptor => ({
      name: "memory",
      kind: "memory",
      webhook: false,
      capabilities: ["checkout", "quantity"],
      prices: { tier_0: { amount: 1_900, currency: "usd", interval: "month" } },
      seatPrices: {
        tier_0: {
          seat_0: { amount: 1_000, currency: "usd" },
          seat_1: { amount: 2_000, currency: "usd" },
        },
      },
      seatScope: scope,
    });
    const input: ScopeCase = {
      quantity: true,
      scope: "subscription",
      tiers: [
        {
          currency: "usd",
          price: 1_900,
          seats: [
            { billable: true, included: 5, seatPrice: 1_000 },
            { billable: true, included: 1, seatPrice: 2_000 },
          ],
        },
      ],
    };
    const catalog = Result.getOrThrow(scopeCatalogOf(input));
    const subscription = validateProviderMappings(catalog, [twoSeats("subscription")]);
    expect(subscription?._tag).toBe("CatalogPriceMismatch");
    if (subscription?._tag === "CatalogPriceMismatch") {
      expect(subscription.field).toBe("seatPrices");
      expect(subscription.actual).toBe("2");
    }
    expect(validateProviderMappings(catalog, [twoSeats("feature")])).toBe(null);
  });
});
