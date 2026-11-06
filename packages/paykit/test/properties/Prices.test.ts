import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import {
  chargeOfPricing,
  priceKey,
  priceOf,
  priceOfUnits,
  pricedLines,
  pricesOf,
  pricing,
  soleUnitPriceOf,
  unitsOf,
  type PriceBandInput,
  type Pricing,
} from "../../src/Pricing.ts";
import { chargeOf, pricedOf } from "../../src/Subscription/Subscription.state.ts";
import { assertProperty } from "../support/Property.ts";

const Amount = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 })));
const Units = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10 })));
const Count = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 400 })));
const Currency = Schema.Literals(["usd", "eur"]);

const UnitPriceSpec = Schema.Struct({
  amount: Amount,
  currency: Currency,
  units: Schema.optionalKey(Units),
});

const BandSpec = Schema.Struct({
  upTo: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  amount: Amount,
  units: Schema.optionalKey(Units),
});

/**
 * A price as an author might state it. A banded spec is built into an ordered
 * ladder ending at `"inf"` by {@link build}, so every generated value is a
 * price the catalog would accept rather than one it would refuse.
 */
const PricingSpec = Schema.Union([
  Schema.TaggedStruct("unit", { unitPrice: UnitPriceSpec }),
  Schema.TaggedStruct("banded", {
    kind: Schema.Literals(["graduated", "volume"]),
    currency: Currency,
    bands: Schema.Array(BandSpec).pipe(Schema.check(Schema.isMaxLength(3))),
  }),
]);
type PricingSpec = typeof PricingSpec.Type;

const ladderOf = (
  bands: ReadonlyArray<typeof BandSpec.Type>,
  currency: string,
): ReadonlyArray<PriceBandInput> => {
  const sorted = [...bands].sort((left, right) => left.upTo - right.upTo);
  const seen = new Set<number>();
  const ladder: Array<PriceBandInput> = [];
  for (const entry of sorted) {
    if (seen.has(entry.upTo)) continue;
    seen.add(entry.upTo);
    ladder.push({
      upTo: entry.upTo,
      amount: entry.amount,
      currency,
      ...(entry.units === undefined ? {} : { units: entry.units }),
    });
  }
  if (ladder.length === 0) ladder.push({ upTo: "inf", amount: 1, currency });
  // The last band is unbounded, whatever ceiling the author stated for it.
  ladder[ladder.length - 1] = { ...ladder[ladder.length - 1]!, upTo: "inf" };
  return ladder;
};

const build = (spec: PricingSpec): Pricing =>
  spec._tag === "unit"
    ? pricing({ kind: "unit", ...spec.unitPrice })
    : pricing({
        kind: spec.kind,
        currency: spec.currency,
        bands: ladderOf(spec.bands, spec.currency),
      });

const kindOf = (spec: PricingSpec): "unit" | "graduated" | "volume" =>
  spec._tag === "unit" ? "unit" : spec.kind;

const sum = (values: ReadonlyArray<number>): number =>
  values.reduce((total, value) => total + value, 0);

describe("the price is a function of the billable count", () => {
  /**
   * The whole point of stating a price as a cumulative function: an event bills
   * the difference it makes, so how the same units are split across events — or
   * the order they arrive in — cannot change what the period owes.
   */
  it.effect("splitting a bill into events never changes the total", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          pricing: PricingSpec,
          events: Schema.Array(Amount).pipe(
            Schema.check(Schema.isMinLength(1)),
            Schema.check(Schema.isMaxLength(8)),
          ),
        }),
      ),
      ({ pricing: spec, events }) => {
        const price = build(spec);
        let billed = 0;
        let count = 0;
        for (const amount of events) {
          billed += chargeOfPricing(price, count, count + amount);
          count += amount;
        }
        return billed === priceOf(price, count);
      },
      { runs: 120, size: 30 },
    ),
  );

  /**
   * A `PricedLine` is the event's own evidence: its money sums to `charge` and
   * its quantity is a real part of the event. A package price may leave some
   * units unbilled on a line (a partial package costs a whole one), and a
   * volume crossing may make the difference signed, which is the vendor's
   * volume semantics rather than a lost unit.
   */
  it.effect("an event records lines whose money is the charge and whose quantity is bounded", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          pricing: PricingSpec,
          before: Count,
          amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
        }),
      ),
      ({ pricing: spec, before, amount }) => {
        const price = build(spec);
        const after = before + amount;
        const charge = chargeOfPricing(price, before, after);
        const lines = pricedLines(price, before, after);
        const kind = kindOf(spec);

        if (sum(lines.map((line) => line.amount)) !== charge) return false;
        if (!lines.every((line) => line.quantity > 0)) return false;
        if (!lines.every((line) => line.key === priceKey(line.unitPrice))) return false;

        if (kind === "unit") {
          if (sum(lines.map((line) => line.quantity)) !== amount) return false;
        } else if (sum(lines.map((line) => line.quantity)) > amount) {
          // A package price can cover an event's whole delta with a package it
          // already bought, and a zero-amount volume crossing records no line.
          return false;
        }

        // A unit and a graduated ladder never bill a later unit at a lower
        // cumulative price, so an event's charge cannot be negative. A volume
        // ladder can reprice the whole total downward when it crosses a band.
        if (kind !== "volume" && charge < 0) return false;
        if (amount === 0 && (charge !== 0 || lines.length !== 0)) return false;
        return true;
      },
      { runs: 120, size: 30 },
    ),
  );

  it.effect("a unit or graduated price never falls as the count grows", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          pricing: PricingSpec,
          first: Count,
          second: Count,
        }),
      ),
      ({ pricing: spec, first, second }) => {
        if (kindOf(spec) === "volume") return true;
        const price = build(spec);
        const [before, after] = first <= second ? [first, second] : [second, first];
        return priceOf(price, before) <= priceOf(price, after);
      },
      { runs: 120, size: 30 },
    ),
  );

  /**
   * The standing records a charge from `included` and the period's `used`, so
   * it has to be the same arithmetic the pricing module states on the billable
   * part. The free grant is never a billable unit, and an event inside it
   * records no money at all.
   */
  it.effect(
    "the standing's charge is the price of the billable part, never of the free grant",
    () =>
      assertProperty(
        Arbitrary.schema(
          Schema.Struct({
            pricing: PricingSpec,
            included: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
            used: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 300 }))),
            amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
          }),
        ),
        ({ pricing: spec, included, used, amount }) => {
          const price = build(spec);
          const billableBefore = Math.max(0, used - included);
          const billableAfter = Math.max(0, used + amount - included);
          const charge = chargeOf(price, included, used, amount);
          const lines = pricedOf(price, included, used, amount);

          if (charge !== chargeOfPricing(price, billableBefore, billableAfter)) return false;
          if (sum(lines.map((line) => line.amount)) !== charge) return false;
          if (used + amount <= included) return charge === 0 && lines.length === 0;
          return true;
        },
        { runs: 120, size: 30 },
      ),
  );
});

describe("a package price buys whole packages", () => {
  const Package = Schema.Struct({
    amount: Amount,
    units: Units,
    count: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 60 }))),
    packages: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
  });

  it.effect("rounds a partial package up and bills a whole package exactly", () =>
    assertProperty(
      Arbitrary.schema(Package),
      ({ amount, units, count, packages }) => {
        const price = { amount, currency: "usd" as const, units };
        if (unitsOf(price) !== units) return false;
        if (priceOfUnits(price, count) !== Math.ceil(count / units) * amount) return false;
        if (priceOfUnits(price, packages * units) !== packages * amount) return false;
        return priceOfUnits(price, 0) === 0;
      },
      { runs: 100 },
    ),
  );

  it("bills 1,500 units at a $5-per-1,000 price as two packages", () => {
    const price = pricing({ kind: "unit", amount: 500, currency: "usd", units: 1_000 });
    expect(priceOf(price, 1_500)).toBe(1_000);
    expect(priceOf(price, 1_000)).toBe(500);
    expect(priceOf(price, 1)).toBe(500);
  });
});

describe("the price identity", () => {
  it.effect("two unit prices share a key exactly when they are the same price", () =>
    assertProperty(
      Arbitrary.schema(Schema.Struct({ left: UnitPriceSpec, right: UnitPriceSpec })),
      ({ left, right }) => {
        const samePrice =
          left.amount === right.amount &&
          left.currency === right.currency &&
          unitsOf(left) === unitsOf(right);
        return (priceKey(left) === priceKey(right)) === samePrice;
      },
      { runs: 100 },
    ),
  );

  it.effect("a pricing names one price only when it states exactly one", () =>
    assertProperty(
      Arbitrary.schema(PricingSpec),
      (spec) => {
        const price = build(spec);
        const sole = soleUnitPriceOf(price);
        if ((sole !== null) !== (pricesOf(price).length === 1)) return false;
        return (
          spec._tag !== "unit" || (sole !== null && priceKey(sole) === priceKey(spec.unitPrice))
        );
      },
      { runs: 100 },
    ),
  );

  it("a volume ladder reprices the whole total, so a crossing can lower the bill", () => {
    const volume = pricing({
      kind: "volume",
      currency: "usd",
      bands: [
        { upTo: 100, amount: 10, currency: "usd" },
        { upTo: "inf", amount: 5, currency: "usd" },
      ],
    });
    expect(priceOf(volume, 100)).toBe(1_000);
    expect(priceOf(volume, 101)).toBe(505);
    // The signed delta is the ADR's volume semantics, not a lost unit.
    expect(chargeOfPricing(volume, 100, 101)).toBe(-495);
  });

  it("a graduated ladder charges each band's own rate", () => {
    const graduated = pricing({
      kind: "graduated",
      currency: "usd",
      bands: [
        { upTo: 10, amount: 2, currency: "usd" },
        { upTo: "inf", amount: 1, currency: "usd" },
      ],
    });
    expect(priceOf(graduated, 10)).toBe(20);
    expect(priceOf(graduated, 12)).toBe(22);
    expect(pricedLines(graduated, 9, 12).map((line) => line.amount)).toEqual([2, 2]);
  });
});
