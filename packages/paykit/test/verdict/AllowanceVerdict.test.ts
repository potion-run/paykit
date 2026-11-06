import { describe, expect, it } from "@alchemy.run/test";
import { allowance } from "../../src/Allowance.ts";
import { messages } from "../../src/Feature.ts";
import {
  capacityOf,
  downgradeOf,
  moneyOverflowOf,
  type JudgedFeature,
} from "../../src/Subscription/Allowance.verdict.ts";
import { allowsOne } from "../../src/Subscription/Entitlements.view.ts";

/** A counted allowance with room, unless the test says otherwise. */
const judged = (over: Partial<JudgedFeature> = {}): JudgedFeature => ({
  overage: "block",
  included: 100,
  billed: 0,
  used: 0,
  reserved: 0,
  remaining: 100,
  ...over,
});

const ask = (amount: number, dimension?: string) => ({
  amount,
  ...(dimension === undefined ? {} : { dimension }),
});

const usd = { amount: 2, currency: "usd" };

describe("capacity", () => {
  it("allows an amount that fits a blocking count", () => {
    expect(
      capacityOf({ standing: "good", feature: judged({ remaining: 60, used: 40 }), ask: ask(60) }),
    ).toEqual({ _tag: "Allowed" });
  });

  it("refuses past a blocking count, with the count it ran past", () => {
    expect(
      capacityOf({ standing: "good", feature: judged({ remaining: 60, used: 40 }), ask: ask(61) }),
    ).toEqual({ _tag: "Remaining", requested: 61, remaining: 60 });
  });

  it("treats a feature the tier grants nothing as blocking at zero", () => {
    expect(
      capacityOf({
        standing: "good",
        feature: judged({ included: null, remaining: 0, overage: "block" }),
        ask: ask(1),
      }),
    ).toEqual({ _tag: "Remaining", requested: 1, remaining: 0 });
  });

  it("never runs out of an unlimited allowance or a flag", () => {
    expect(
      capacityOf({
        standing: "good",
        feature: judged({ included: "unlimited", remaining: null }),
        ask: ask(1_000_000),
      }),
    ).toEqual({ _tag: "Allowed" });
    expect(
      capacityOf({
        standing: "good",
        feature: judged({ included: 1, overage: "allow", remaining: null }),
        ask: ask(1_000_000),
      }),
    ).toEqual({ _tag: "Allowed" });
  });

  it("prices a credit-priced feature at its card's rate", () => {
    const credit = judged({
      included: null,
      overage: "block",
      remaining: 100,
      creditRates: { default: 1, "gpt-large": 10 },
    });
    expect(capacityOf({ standing: "good", feature: credit, ask: ask(100) })).toEqual({
      _tag: "Allowed",
    });
    // Ten credits a unit, so ten units exhaust a hundred-credit pool.
    expect(capacityOf({ standing: "good", feature: credit, ask: ask(11, "gpt-large") })).toEqual({
      _tag: "Credits",
      cost: 110,
      available: 100,
    });
  });

  it("judges the cap from remaining + cap, so a rollover does not raise it", () => {
    // 100 included, 20 more billable, and 20 carried in from the last period:
    // the ceiling stays 120, not 140.
    const carried = judged({ included: 100, cap: 20, carried: 20, remaining: 120 });
    expect(capacityOf({ standing: "good", feature: carried, ask: ask(120) })).toEqual({
      _tag: "Allowed",
    });
    expect(capacityOf({ standing: "good", feature: carried, ask: ask(121) })).toEqual({
      _tag: "Ceiling",
      cap: 20,
      headroom: 120,
      requested: 121,
    });
  });

  it("counts open holds against the ceiling", () => {
    // 100 used and 70 held against 100 + 20: the headroom is already negative.
    expect(
      capacityOf({
        standing: "good",
        feature: judged({ cap: 20, remaining: -70, used: 100, reserved: 70 }),
        ask: ask(1),
      }),
    ).toEqual({ _tag: "Ceiling", cap: 20, headroom: -50, requested: 1 });
  });

  it("judges money and every open hold as one run past used", () => {
    // Included room is spent once: 500 units bill 1,000, however they split
    // between this event and the holds already open.
    const money = judged({
      overage: "bill",
      included: 100,
      used: 100,
      remaining: 0,
      unitPrice: usd,
      moneyCap: 1_000,
    });
    expect(capacityOf({ standing: "good", feature: money, ask: ask(500) })).toEqual({
      _tag: "Allowed",
    });
    expect(
      capacityOf({ standing: "good", feature: { ...money, reserved: 10 }, ask: ask(491) }),
    ).toEqual({ _tag: "Money", cap: 1_000, billed: 0, promised: 1_002 });
  });

  it("refuses the standing before it judges anything else", () => {
    expect(
      capacityOf({
        standing: "blocked",
        feature: judged({ cap: 0, remaining: 0, moneyCap: 0, unitPrice: usd }),
        ask: ask(1),
      }),
    ).toEqual({ _tag: "Standing", standing: "blocked" });
  });

  it("refuses the cap before the money ceiling", () => {
    expect(
      capacityOf({
        standing: "good",
        feature: judged({ cap: 0, remaining: 0, moneyCap: 0, unitPrice: usd }),
        ask: ask(1),
      }),
    ).toEqual({ _tag: "Ceiling", cap: 0, headroom: 0, requested: 1 });
  });

  it("refuses the money ceiling before a blocking count", () => {
    expect(
      capacityOf({
        standing: "good",
        feature: judged({ included: 100, used: 100, remaining: -1, moneyCap: 0, unitPrice: usd }),
        ask: ask(1),
      })._tag,
    ).toBe("Money");
  });
});

describe("moneyOverflowOf", () => {
  it("is silent when the allowance states no money ceiling", () => {
    expect(moneyOverflowOf(judged(), 1_000)).toBe(null);
  });

  it("names the total the request puts at risk", () => {
    expect(
      moneyOverflowOf(
        judged({ included: 100, used: 100, remaining: 0, unitPrice: usd, moneyCap: 100 }),
        51,
      ),
    ).toEqual({ cap: 100, billed: 0, promised: 102 });
  });

  it("judges reserved units at the position they are promised at", () => {
    // 100 used, 10 held, 50 billed now: 60 units past `included` bill 120.
    expect(
      moneyOverflowOf(
        judged({
          included: 100,
          used: 100,
          reserved: 10,
          remaining: -10,
          unitPrice: usd,
          moneyCap: 119,
        }),
        50,
      ),
    ).toEqual({ cap: 119, billed: 0, promised: 120 });
  });
});

describe("downgrade", () => {
  const moved = (over: Partial<Parameters<typeof downgradeOf>[0]> = {}) => ({
    included: 100,
    overage: "block" as const,
    ...over,
  });

  it("refuses a blocking count the period is already past", () => {
    expect(downgradeOf(moved(), { used: 80, reserved: 30, billed: 0 })).toEqual({
      _tag: "Usage",
      included: 100,
      used: 80,
      reserved: 30,
    });
  });

  it("omits the held units when nothing is held", () => {
    expect(downgradeOf(moved(), { used: 101, reserved: 0, billed: 0 })).toEqual({
      _tag: "Usage",
      included: 100,
      used: 101,
    });
  });

  it("never refuses a billed or allowed allowance for being past included", () => {
    expect(
      downgradeOf(moved({ overage: "bill" }), { used: 10_000, reserved: 0, billed: 0 }),
    ).toEqual({ _tag: "Allowed" });
    expect(
      downgradeOf(moved({ overage: "allow" }), { used: 10_000, reserved: 0, billed: 0 }),
    ).toEqual({ _tag: "Allowed" });
  });

  it("refuses a money ceiling the period already billed past", () => {
    expect(
      downgradeOf(moved({ overage: "bill", moneyCap: 500 }), { used: 0, reserved: 0, billed: 501 }),
    ).toEqual({ _tag: "Spend", moneyCap: 500, billed: 501 });
  });

  it("refuses a unit ceiling the period already reached", () => {
    expect(
      downgradeOf(moved({ overage: "bill", cap: 20 }), { used: 100, reserved: 21, billed: 0 }),
    ).toEqual({ _tag: "Ceiling", ceiling: 120, used: 100, reserved: 21 });
  });

  it("reports the blocking count before the money ceiling and the ceiling last", () => {
    const counted = moved({ cap: 20, moneyCap: 0 });
    expect(downgradeOf(counted, { used: 101, reserved: 0, billed: 1 })._tag).toBe("Usage");
    expect(downgradeOf(moved({ moneyCap: 0 }), { used: 1, reserved: 0, billed: 1 })._tag).toBe(
      "Spend",
    );
  });

  it("has no ceiling to refuse on an unlimited allowance", () => {
    expect(
      downgradeOf(moved({ included: "unlimited" }), { used: 10_000, reserved: 0, billed: 0 }),
    ).toEqual({ _tag: "Allowed" });
  });

  it("reads a catalog allowance the way the model does", () => {
    const pro = allowance(messages, {
      included: 100,
      overage: "bill",
      cap: 20,
      unitPrice: usd,
      moneyCap: 5_000,
    });
    expect(downgradeOf(pro, { used: 130, reserved: 0, billed: 0 })._tag).toBe("Ceiling");
    expect(downgradeOf(pro, { used: 0, reserved: 0, billed: 5_001 })._tag).toBe("Spend");
    expect(downgradeOf(pro, { used: 0, reserved: 0, billed: 0 })._tag).toBe("Allowed");
  });
});

describe("allowsOne", () => {
  it("takes the rollover out of the cap, like the write path does", () => {
    // 100 included, 20 more billable, 20 carried: the ceiling is 120, and the
    // carried units spend it rather than extending it.
    const at = (remaining: number) =>
      judged({
        overage: "bill",
        included: 100,
        cap: 20,
        carried: 20,
        used: 120 - remaining,
        remaining,
      });
    expect(allowsOne("good", at(0))).toBe(false);
    expect(allowsOne("good", at(1))).toBe(true);
  });
});
