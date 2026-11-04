import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { prorate, unusedFraction } from "../../src/Proration.ts";
import { assertProperty } from "../support/Property.ts";
import { Amount, start } from "./Arbitraries.ts";

const PriceInput = Schema.Struct({
  amount: Amount,
  currency: Schema.Literals(["usd", "eur"]),
  interval: Schema.Literals(["month", "annual"]),
});

const PeriodDays = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 90 })));

const ProrationCase = Schema.Struct({
  from: Schema.optionalKey(PriceInput),
  to: Schema.optionalKey(PriceInput),
  periodDays: PeriodDays,
  /** Days from the period start; negative and past-the-end instants are legal. */
  offsetDays: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -30, maximum: 120 }))),
});
type ProrationCase = typeof ProrationCase.Type;

const periodOf = (days: number) => {
  const periodStart = start;
  const periodEnd = DateTime.add(start, { days });
  return { start: periodStart, end: periodEnd };
};

describe("proration", () => {
  it.effect("keeps the unused fraction in [0, 1] and never charges outside the prices", () =>
    assertProperty(
      Arbitrary.schema(ProrationCase),
      (input) => {
        const period = periodOf(input.periodDays);
        const at = DateTime.add(start, { days: input.offsetDays });
        const fraction = unusedFraction(period, at);
        if (!(fraction >= 0 && fraction <= 1)) return false;

        const value = prorate({ from: input.from, to: input.to, period, at });
        if (input.from === undefined && input.to === undefined) return value === null;
        if (
          input.from !== undefined &&
          input.to !== undefined &&
          (input.from.currency !== input.to.currency || input.from.interval !== input.to.interval)
        ) {
          return value === null;
        }
        if (value === null) return false;

        const currency = input.from?.currency ?? input.to!.currency;
        if (value.currency !== currency) return false;
        if (value.due !== value.charge - value.credit) return false;
        if (value.credit < 0 || value.credit > (input.from?.amount ?? 0)) return false;
        if (value.charge < 0 || value.charge > (input.to?.amount ?? 0)) return false;

        // At the boundaries the whole unused share is on one side or the
        // other, with no rounding residue.
        if (input.offsetDays <= 0) {
          if (value.credit !== (input.from?.amount ?? 0)) return false;
          if (value.charge !== (input.to?.amount ?? 0)) return false;
        }
        if (input.offsetDays >= input.periodDays) {
          return value.credit === 0 && value.charge === 0;
        }
        return true;
      },
      { runs: 120, size: 30 },
    ),
  );

  it.effect("a no-op change costs exactly nothing at every instant", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          price: PriceInput,
          periodDays: PeriodDays,
          offsetDays: Schema.Int.pipe(
            Schema.check(Schema.isBetween({ minimum: -30, maximum: 120 })),
          ),
        }),
      ),
      (input) => {
        const period = periodOf(input.periodDays);
        const at = DateTime.add(start, { days: input.offsetDays });
        const value = prorate({ from: input.price, to: input.price, period, at });
        return value !== null && value.due === 0 && value.credit === value.charge;
      },
      { runs: 60 },
    ),
  );

  it("refuses a cross-currency or cross-cadence proration", () => {
    const period = periodOf(31);
    expect(
      prorate({
        from: { amount: 1_900, currency: "usd", interval: "month" },
        to: { amount: 9_900, currency: "eur", interval: "month" },
        period,
        at: start,
      }),
    ).toBe(null);
    expect(
      prorate({
        from: { amount: 1_900, currency: "usd", interval: "month" },
        to: { amount: 9_900, currency: "usd", interval: "annual" },
        period,
        at: start,
      }),
    ).toBe(null);
  });

  it("returns null when neither side has a price", () => {
    expect(prorate({ from: undefined, to: undefined, period: periodOf(31), at: start })).toBe(null);
  });

  it("charges the full price at the start and nothing at the end", () => {
    const period = periodOf(31);
    expect(
      prorate({
        from: { amount: 1_900, currency: "usd", interval: "month" },
        to: { amount: 2_000, currency: "usd", interval: "month" },
        period,
        at: start,
      }),
    ).toEqual({ currency: "usd", credit: 1_900, charge: 2_000, due: 100 });
    expect(
      prorate({
        from: { amount: 1_900, currency: "usd", interval: "month" },
        to: { amount: 2_000, currency: "usd", interval: "month" },
        period,
        at: period.end,
      }),
    ).toEqual({ currency: "usd", credit: 0, charge: 0, due: 0 });
  });
});
