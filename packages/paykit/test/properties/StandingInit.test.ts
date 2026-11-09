import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import {
  allowance,
  grant,
  isQuantityGrant,
  type Allowance,
  type Allowances,
  type Pricing,
  type PricingInput,
} from "../../src/Allowance.ts";
import { feature } from "../../src/Feature.ts";
import {
  PlanItem,
  PlanItemProration,
  PlanItemReset,
  PlanItemRollover,
  planItem,
  prorationOf,
  resetOf,
  rolloverOf,
} from "../../src/PlanItem.ts";
import {
  carriedPrepaidOf,
  startingQuantities,
  startingRemaining,
  unitPriceCurrencyOf,
} from "../../src/Subscription/Standing.ts";
import {
  includedRemainingOf,
  prepaidCreditsOf,
  quantityAfterTierChange,
  type QuantityCounts,
  type SubscriptionState,
} from "../../src/Subscription/Subscription.state.ts";
import { assertProperty } from "../support/Property.ts";

const features = {
  messages: feature({ id: "messages", name: "Messages" }),
  ai: feature({ id: "ai", name: "AI" }),
  seats: feature({ id: "seats", name: "Seats", kind: "non_consumable" }),
  sso: feature({ id: "sso", name: "SSO", kind: "flag" }),
} as const;

const ResetsSpec = Schema.Literals([
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "semi_annual",
  "annual",
  "never",
]);

const UnitsSpec = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 6 })));

const MoneySpec = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })));

const IncludedSpec = Schema.Union([
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 500 }))),
  Schema.Literal("unlimited"),
]);

const UnitPriceSpec = Schema.Struct({
  amount: MoneySpec,
  currency: Schema.Literals(["usd", "eur"]),
});

const PriceSpec = Schema.Union([
  Schema.TaggedStruct("none", {}),
  Schema.TaggedStruct("unitPrice", { unitPrice: UnitPriceSpec }),
  Schema.TaggedStruct("pricing", {
    kind: Schema.Literals(["unit", "graduated", "volume"]),
    currency: Schema.Literals(["usd", "eur"]),
    amount: MoneySpec,
  }),
]);

type PriceSpec = typeof PriceSpec.Type;

const MeteredSpec = Schema.TaggedStruct("metered", {
  feature: Schema.Literals(["messages", "ai"]),
  included: IncludedSpec,
  resets: ResetsSpec,
  resetEvery: Schema.optionalKey(UnitsSpec),
  carryOver: Schema.Boolean,
  carryCap: Schema.optionalKey(MoneySpec),
  prorate: Schema.optionalKey(Schema.Literals(["immediate", "period_end"])),
  overage: Schema.Literals(["block", "allow"]),
  price: PriceSpec,
  cap: Schema.optionalKey(MoneySpec),
  moneyCap: Schema.optionalKey(MoneySpec),
});

type MeteredSpec = typeof MeteredSpec.Type;

const QuantitySpec = Schema.TaggedStruct("quantity", {
  included: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  overage: Schema.Literals(["block", "allow"]),
  prorate: Schema.optionalKey(Schema.Literals(["immediate", "period_end"])),
});

type QuantitySpec = typeof QuantitySpec.Type;

const FlagSpec = Schema.TaggedStruct("flag", {});

const ItemSpec = Schema.Union([MeteredSpec, QuantitySpec, FlagSpec]);

type ItemSpec = typeof ItemSpec.Type;

const ItemList = Schema.Array(ItemSpec).pipe(Schema.check(Schema.isMaxLength(4)));

const Counts = Schema.Struct({
  messages: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  ai: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  seats: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  sso: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
});

const pricingInputOf = (spec: Extract<PriceSpec, { _tag: "pricing" }>): PricingInput =>
  spec.kind === "unit"
    ? { kind: "unit", amount: spec.amount, currency: spec.currency }
    : {
        kind: spec.kind,
        currency: spec.currency,
        bands: [
          { upTo: 10, amount: 1, currency: spec.currency },
          { upTo: "inf", amount: spec.amount, currency: spec.currency },
        ],
      };

const meteredItemOf = (spec: MeteredSpec): Allowance => {
  const featureValue = spec.feature === "messages" ? features.messages : features.ai;

  const common = {
    resets: spec.resets,
    ...(spec.resetEvery === undefined ? {} : { resetEvery: spec.resetEvery }),
    carryOver: spec.carryOver,
    ...(spec.carryCap === undefined ? {} : { carryCap: spec.carryCap }),
    ...(spec.prorate === undefined ? {} : { prorate: spec.prorate }),
  };

  if (spec.included === "unlimited") {
    return allowance(featureValue, {
      included: "unlimited",
      overage: "allow",
      ...common,
    });
  }

  if (spec.price._tag === "none") {
    return allowance(featureValue, {
      included: spec.included,
      overage: spec.overage,
      ...common,
    });
  }

  const billed = {
    included: spec.included,
    overage: "bill" as const,
    ...(spec.cap === undefined ? {} : { cap: spec.cap }),
    ...(spec.moneyCap === undefined ? {} : { moneyCap: spec.moneyCap }),
    ...common,
  };

  if (spec.price._tag === "unitPrice") {
    return allowance(featureValue, {
      ...billed,
      unitPrice: spec.price.unitPrice,
    });
  }

  return allowance(featureValue, {
    ...billed,
    pricing: pricingInputOf(spec.price),
  });
};

const quantityItemOf = (spec: QuantitySpec): Allowance =>
  allowance(features.seats, {
    included: spec.included,
    overage: spec.overage,
    ...(spec.prorate === undefined ? {} : { prorate: spec.prorate }),
  });

const itemOf = (spec: ItemSpec): Allowance =>
  spec._tag === "metered"
    ? meteredItemOf(spec)
    : spec._tag === "quantity"
      ? quantityItemOf(spec)
      : grant(features.sso);

const keyOf = (spec: ItemSpec): string =>
  spec._tag === "metered" ? spec.feature : spec._tag === "quantity" ? "seats" : "sso";

/** One allowance record from generated item specs, later duplicates winning. */
const allowancesOf = (specs: ReadonlyArray<ItemSpec>): Allowances =>
  Object.fromEntries(specs.map((spec) => [keyOf(spec), itemOf(spec)]));

const notGreater = (left: number | null, right: number | null): boolean =>
  left === null ? right === null : right !== null && left <= right;

/**
 * The currency a plan item prices with, read from the two fields the catalog
 * accepts rather than from the helper `unitPriceCurrencyOf` uses.
 */
const currencyOfItem = (item: Allowance): string | undefined => {
  if (item.pricing !== undefined) {
    const pricing: Pricing = item.pricing;

    return pricing._tag === "unit" ? pricing.unitPrice.currency : pricing.currency;
  }

  return item.unitPrice?.currency;
};

describe("starting counts", () => {
  /**
   * A quantity is not a counter: only a `non_consumable` allowance with a count
   * has a starting quantity, and that quantity is its free grant.
   */
  it.effect("starting quantities are exactly the non-consumable counts", () =>
    assertProperty(
      Arbitrary.schema(ItemList),
      (specs) => {
        const allowances: Allowances = {
          ...allowancesOf(specs),
          // A quantity is guaranteed, so the property never shrinks to the
          // empty record and stays a statement about the quantity branch.
          seats: allowance(features.seats, { included: 5 }),
        };

        const quantities = startingQuantities(allowances);
        const expected = new Map<string, number>();

        for (const [featureId, item] of Object.entries(allowances)) {
          if (isQuantityGrant(item) && typeof item.included === "number") {
            expected.set(featureId, item.included);
          }
        }

        if (Object.keys(quantities).length !== expected.size) return false;

        for (const [featureId, included] of expected) {
          if (quantities[featureId] !== included) return false;
        }

        for (const [featureId, quantity] of Object.entries(quantities)) {
          if (!expected.has(featureId)) return false;

          if (!Number.isInteger(quantity) || quantity < 0) return false;
        }

        return true;
      },
      { runs: 120, size: 30 },
    ),
  );

  /**
   * A fresh period starts a count at what the allowance includes and starts an
   * unbounded allowance at `null`, the absence of a count rather than zero.
   * Every allowance the plan states appears, and no other key does.
   */
  it.effect("a fresh period is the free grant for a count and null for no count", () =>
    assertProperty(
      Arbitrary.schema(ItemList),
      (specs) => {
        const allowances: Allowances = {
          ...allowancesOf(specs),
          // One of each kind is guaranteed, so every branch of the projection
          // is exercised even when a generated record is small.
          seats: allowance(features.seats, { included: 5 }),
          sso: grant(features.sso),
          ai: allowance(features.ai, { included: "unlimited" }),
        };

        const remaining = startingRemaining(allowances);
        const keys = Object.keys(allowances);

        if (Object.keys(remaining).length !== keys.length) return false;

        for (const [featureId, item] of Object.entries(allowances)) {
          if (!Object.hasOwn(remaining, featureId)) return false;

          if (item.included === "unlimited" || item.kind === "flag") {
            if (remaining[featureId] !== null) return false;
            continue;
          }

          if (typeof remaining[featureId] !== "number") return false;

          const included = typeof item.included === "number" ? item.included : 0;

          if (remaining[featureId] !== includedRemainingOf(item)) return false;

          if (isQuantityGrant(item)) {
            if (remaining[featureId] !== quantityAfterTierChange(included, included)) return false;
          }
        }

        for (const featureId of Object.keys(remaining)) {
          if (!Object.hasOwn(allowances, featureId)) return false;
        }

        return true;
      },
      { runs: 120, size: 30 },
    ),
  );

  /**
   * A tier change keeps the purchase and raises it to the new free grant, and
   * occupancy is subtracted afterwards. Neither map can add a key, a purchase
   * never takes the free grant away, and occupancy never hands a count back.
   */
  it.effect("a purchase never drops below the grant and occupancy only lowers a count", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          grants: ItemList,
          purchased: Counts,
          occupied: Counts,
        }),
      ),
      ({ grants, purchased, occupied }) => {
        const allowances: Allowances = {
          ...allowancesOf(grants),
          // A quantity, a flag and an unbounded count are always present, so
          // both sides of the map's effect are exercised by every run.
          seats: allowance(features.seats, { included: 5 }),
          sso: grant(features.sso),
          ai: allowance(features.ai, { included: "unlimited" }),
        };

        const purchasedCounts: QuantityCounts = purchased;
        const occupiedCounts: QuantityCounts = occupied;

        const free = startingRemaining(allowances);
        const held = startingRemaining(allowances, purchasedCounts);
        const used = startingRemaining(allowances, purchasedCounts, occupiedCounts);

        if (Object.keys(held).length !== Object.keys(allowances).length) return false;

        if (Object.keys(used).length !== Object.keys(allowances).length) return false;

        for (const [featureId, item] of Object.entries(allowances)) {
          const included = typeof item.included === "number" ? item.included : 0;

          const expectedHeld = isQuantityGrant(item)
            ? quantityAfterTierChange(purchasedCounts[featureId] ?? included, included)
            : includedRemainingOf(item);

          const expectedUsed = isQuantityGrant(item)
            ? quantityAfterTierChange(purchasedCounts[featureId] ?? included, included) -
              (occupiedCounts[featureId] ?? 0)
            : includedRemainingOf(item);

          if (held[featureId] !== expectedHeld) return false;

          if (used[featureId] !== expectedUsed) return false;

          if (!notGreater(free[featureId], held[featureId])) return false;

          if (!notGreater(used[featureId], held[featureId])) return false;
        }

        return true;
      },
      { runs: 120, size: 30 },
    ),
  );

  it("an empty allowance set starts with nothing", () => {
    expect(startingQuantities({})).toEqual({});
    expect(startingRemaining({})).toEqual({});
    expect(startingRemaining({}, { seats: 10 }, { seats: 3 })).toEqual({});
  });
});

describe("prepaid carry", () => {
  /**
   * The part a pack already bought is clamped to the pool an activation writes,
   * so a damaged state cannot protect more than the account holds, and a zero
   * part is absent from the event rather than written as zero.
   */
  it.effect("clamps to the new pool and omits the field when nothing survives", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          prepaid: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))),
          credits: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))),
        }),
      ),
      ({ prepaid, credits }) => {
        const state: SubscriptionState = {
          _tag: "Unsubscribed",
          refs: {},
          prepaidCredits: prepaid,
        };

        const carried = carriedPrepaidOf(state, credits);
        const expected = Math.min(prepaidCreditsOf(state), credits);

        if (expected === 0) return !Object.hasOwn(carried, "prepaidCredits");

        if (carried.prepaidCredits !== expected) return false;

        if (carried.prepaidCredits > credits) return false;

        return carried.prepaidCredits <= prepaidCreditsOf(state);
      },
      { runs: 100, size: 30 },
    ),
  );

  it("omits the field for a state that never bought a pack", () => {
    expect(carriedPrepaidOf({ _tag: "Unsubscribed", refs: {} }, 100)).toEqual({});
    expect(carriedPrepaidOf({ _tag: "Unsubscribed", refs: {}, prepaidCredits: 200 }, 100)).toEqual({
      prepaidCredits: 100,
    });
  });
});

describe("the standing's currency", () => {
  /**
   * A plan states one currency for its postpaid prices, so the first allowance
   * that prices anything answers for the standing. A plan with no price at all
   * has no currency to derive, and the activation inherits the previous one.
   */
  it.effect("is the first priced allowance's currency, and undefined when nothing is priced", () =>
    assertProperty(
      Arbitrary.schema(ItemList),
      (specs) => {
        const allowances = allowancesOf(specs);

        const expected = Object.values(allowances)
          .map(currencyOfItem)
          .find((currency) => currency !== undefined);

        const actual = unitPriceCurrencyOf(allowances);

        return expected === undefined ? actual === undefined : actual === expected;
      },
      { runs: 120, size: 30 },
    ),
  );

  it("reads the one-rate shorthand and every banded pricing", () => {
    const unpriced = planItem(features.messages, { included: 10 });

    const shorthand = planItem(features.messages, {
      included: 10,
      overage: "bill",
      unitPrice: { amount: 5, currency: "eur" },
    });

    const graduated = planItem(features.ai, {
      included: 10,
      overage: "bill",
      pricing: {
        kind: "graduated",
        currency: "usd",
        bands: [
          { upTo: 100, amount: 1, currency: "usd" },
          { upTo: "inf", amount: 2, currency: "usd" },
        ],
      },
    });

    const volume = planItem(features.ai, {
      included: 10,
      overage: "bill",
      pricing: {
        kind: "volume",
        currency: "eur",
        bands: [
          { upTo: 100, amount: 1, currency: "eur" },
          { upTo: "inf", amount: 2, currency: "eur" },
        ],
      },
    });

    expect(unitPriceCurrencyOf({})).toBeUndefined();
    expect(unitPriceCurrencyOf({ messages: unpriced })).toBeUndefined();
    expect(unitPriceCurrencyOf({ messages: unpriced, ai: graduated })).toBe("usd");
    expect(unitPriceCurrencyOf({ messages: shorthand, ai: graduated })).toBe("eur");
    expect(unitPriceCurrencyOf({ ai: graduated, messages: shorthand })).toBe("usd");
    expect(unitPriceCurrencyOf({ messages: unpriced, ai: volume })).toBe("eur");
  });
});

describe("plan-item projections", () => {
  /**
   * The public vocabulary is a total projection of the internal allowance:
   * a reset always has an interval and a positive count, a proration states the
   * same behaviour on an increase and a decrease, and a rollover is null
   * exactly when the item does not carry.
   */
  it.effect("are total and agree with the item they project", () =>
    assertProperty(
      Arbitrary.schema(ItemSpec),
      (spec) => {
        const item = itemOf(spec);

        if (!Schema.is(PlanItem)(item)) return false;

        const reset = resetOf(item);

        if (reset.interval !== item.resets) return false;

        if (reset.count !== (item.resetEvery ?? 1)) return false;

        if (!Number.isInteger(reset.count) || reset.count < 1) return false;

        if (!Schema.is(PlanItemReset)(reset)) return false;

        const proration = prorationOf(item);

        const expectedProration =
          item.prorate === "period_end" ? "prorate_next_cycle" : "prorate_immediately";

        if (proration.onIncrease !== expectedProration) return false;

        if (proration.onDecrease !== expectedProration) return false;

        if (proration.onIncrease !== proration.onDecrease) return false;

        if (!Schema.is(PlanItemProration)(proration)) return false;

        const rollover = rolloverOf(item);

        if (item.carryOver !== true) return rollover === null;

        if (rollover === null) return false;

        const expectedMax =
          item.carryCap ?? (typeof item.included === "number" ? item.included : 0);

        return (
          rollover.max === expectedMax &&
          rollover.expiry === "forever" &&
          rollover.max >= 0 &&
          Schema.is(PlanItemRollover)(rollover)
        );
      },
      { runs: 200, size: 40 },
    ),
  );

  it("defaults the reset count to one and keeps every interval", () => {
    expect(resetOf(planItem(features.messages, { included: 10 }))).toEqual({
      interval: "month",
      count: 1,
    });

    expect(
      resetOf(planItem(features.messages, { included: 10, resets: "day", resetEvery: 4 })),
    ).toEqual({ interval: "day", count: 4 });

    expect(resetOf(planItem(features.messages, { included: 10, resets: "never" }))).toEqual({
      interval: "never",
      count: 1,
    });
  });

  it("prorates a period-end change next cycle and everything else immediately", () => {
    expect(prorationOf(planItem(features.messages, { included: 10 }))).toEqual({
      onIncrease: "prorate_immediately",
      onDecrease: "prorate_immediately",
    });

    expect(prorationOf(planItem(features.seats, { included: 5, prorate: "period_end" }))).toEqual({
      onIncrease: "prorate_next_cycle",
      onDecrease: "prorate_next_cycle",
    });

    expect(prorationOf(planItem(features.seats, { included: 5, prorate: "immediate" }))).toEqual({
      onIncrease: "prorate_immediately",
      onDecrease: "prorate_immediately",
    });
  });

  it("rolls over only what carries, capped by carryCap or included", () => {
    expect(rolloverOf(planItem(features.messages, { included: 100 }))).toBeNull();

    expect(rolloverOf(planItem(features.messages, { included: 100, carryOver: true }))).toEqual({
      max: 100,
      expiry: "forever",
    });

    expect(
      rolloverOf(planItem(features.messages, { included: 100, carryOver: true, carryCap: 20 })),
    ).toEqual({ max: 20, expiry: "forever" });

    expect(
      rolloverOf(planItem(features.messages, { included: "unlimited", carryOver: true })),
    ).toEqual({ max: 0, expiry: "forever" });

    expect(rolloverOf(grant(features.sso))).toBeNull();
  });
});
