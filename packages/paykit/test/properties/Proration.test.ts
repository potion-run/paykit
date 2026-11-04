import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import { prorate, unusedFraction } from "../../src/Proration.ts";

const start = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const end = DateTime.makeUnsafe("2030-02-01T00:00:00Z");
const period = { start, end };
const day = 24 * 60 * 60 * 1000;
const at = (offset: number) => DateTime.makeUnsafe(DateTime.toEpochMillis(start) + offset * day);

const usd = (amount: number, interval: "month" | "annual" = "month") =>
  ({ amount, currency: "usd", interval }) as const;

describe("proration", () => {
  it("keeps the unused fraction inside [0, 1]", () => {
    for (let day = -5; day <= 40; day++) {
      const fraction = unusedFraction(period, at(day));
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
  });

  it("prices a no-op change to zero at every moment in the period", () => {
    for (let day = 1; day <= 31; day++) {
      const value = prorate({ from: usd(1900), to: usd(1900), period, at: at(day) });
      expect(value?.due).toBe(0);
      expect(value?.credit).toBe(value?.charge);
    }
  });

  it("nets the parts to zero across the whole period", () => {
    for (let day = 1; day <= 31; day++) {
      const value = prorate({ from: usd(1900), to: usd(9900), period, at: at(day) });
      if (value === null) throw new Error("expected a proration");
      expect(value.due).toBe(value.charge - value.credit);
      expect(value.credit).toBeGreaterThanOrEqual(0);
      expect(value.credit).toBeLessThanOrEqual(1900);
      expect(value.charge).toBeGreaterThanOrEqual(0);
      expect(value.charge).toBeLessThanOrEqual(9900);
    }
  });

  it("charges the full price at the start and nothing at the end", () => {
    expect(prorate({ from: usd(1900), to: usd(2000), period, at: start })).toEqual({
      currency: "usd",
      credit: 1900,
      charge: 2000,
      due: 100,
    });
    expect(prorate({ from: usd(1900), to: usd(2000), period, at: end })).toEqual({
      currency: "usd",
      credit: 0,
      charge: 0,
      due: 0,
    });
  });

  it("refuses a cross-currency or cross-cadence proration", () => {
    expect(
      prorate({
        from: usd(1900),
        to: { amount: 9900, currency: "eur", interval: "month" },
        period,
        at: start,
      }),
    ).toBe(null);
    expect(prorate({ from: usd(1900), to: usd(9900, "annual"), period, at: start })).toBe(null);
  });

  it("returns null when neither side has a price", () => {
    expect(prorate({ from: undefined, to: undefined, period, at: start })).toBe(null);
  });
});
