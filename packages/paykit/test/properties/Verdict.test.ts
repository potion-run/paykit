import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import type { Included, Overage } from "../../src/Allowance.ts";
import {
  capacityOf,
  downgradeOf,
  moneyOverflowOf,
  type JudgedFeature,
} from "../../src/Subscription/Allowance.verdict.ts";
import { allowsOne } from "../../src/Subscription/Entitlements.view.ts";
import {
  creditRateOf,
  spendCeilingOf,
  type Standing,
} from "../../src/Subscription/Subscription.state.ts";
import { assertProperty } from "../support/Property.ts";

const IncludedSpec = Schema.Union([
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 200 }))),
  Schema.Literal("unlimited"),
]);

const CreditRatesSpec = Schema.Struct({
  default: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
  "gpt-large": Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
});

const UnitPriceSpec = Schema.Struct({
  amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  currency: Schema.Literals(["usd", "eur"]),
});

const FeatureSpec = Schema.Struct({
  standing: Schema.Literals(["good", "grace", "blocked"]),
  overage: Schema.Literals(["block", "bill", "allow"]),
  /** `null` is a feature the tier grants nothing, or a credit-priced one. */
  included: Schema.NullOr(IncludedSpec),
  cap: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  ),
  carried: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 200 }))),
  moneyCap: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20_000 }))),
  ),
  unitPrice: Schema.optionalKey(UnitPriceSpec),
  billed: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20_000 }))),
  used: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 500 }))),
  reserved: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 200 }))),
  /** Negative when a billed allowance has already passed its included count. */
  remaining: Schema.NullOr(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -100, maximum: 500 }))),
  ),
  creditRates: Schema.optionalKey(CreditRatesSpec),
  amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 300 }))),
  dimension: Schema.optionalKey(Schema.Literals(["default", "gpt-large", "unknown"])),
});
type FeatureSpec = typeof FeatureSpec.Type;

const featureOf = (spec: FeatureSpec): JudgedFeature => ({
  overage: spec.overage,
  included: spec.included,
  ...(spec.cap === undefined ? {} : { cap: spec.cap }),
  carried: spec.carried,
  ...(spec.moneyCap === undefined ? {} : { moneyCap: spec.moneyCap }),
  ...(spec.unitPrice === undefined ? {} : { unitPrice: spec.unitPrice }),
  billed: spec.billed,
  used: spec.used,
  reserved: spec.reserved,
  remaining: spec.remaining,
  ...(spec.creditRates === undefined ? {} : { creditRates: spec.creditRates }),
});

const askOf = (amount: number, dimension: string | undefined) => ({
  amount,
  ...(dimension === undefined ? {} : { dimension }),
});

const headroomOf = (feature: JudgedFeature): number | null =>
  feature.cap === undefined || feature.remaining === null
    ? null
    : feature.remaining + feature.cap - (feature.carried ?? 0);

/** The billable part of one request, written independently of `chargeOf`. */
const billable = (included: Included | null, used: number, amount: number): number => {
  if (typeof included !== "number") return 0;
  return Math.max(0, used + amount - included) - Math.max(0, used - included);
};

const promisedOf = (feature: JudgedFeature, amount: number): number =>
  feature.unitPrice === undefined
    ? 0
    : billable(feature.included, feature.used, amount + feature.reserved) *
      feature.unitPrice.amount;

describe("capacity verdicts", () => {
  /**
   * Each tag is evidence: `Allowed` means none of the rules refused, and a
   * refusal states the number it refused against. This is the one judgement the
   * write path, `check()` and the read model's `allowed` all ask, so a wrong
   * verdict is a wrong charge in three places at once.
   */
  it.effect("every verdict is the rule it names, and allowed means every rule fits", () =>
    assertProperty(
      Arbitrary.schema(FeatureSpec),
      (spec) => {
        const feature = featureOf(spec);
        const ask = askOf(spec.amount, spec.dimension);
        const verdict = capacityOf({ standing: spec.standing, feature, ask });
        const headroom = headroomOf(feature);
        const overflow = moneyOverflowOf(feature, spec.amount);
        const creditCost =
          feature.creditRates === undefined
            ? undefined
            : spec.amount * creditRateOf(feature.creditRates, spec.dimension);
        const creditAvailable = feature.remaining ?? 0;

        // The rules in the order the write paths apply them: the first refusal
        // is the one a caller sees.
        const expected =
          spec.standing === "blocked"
            ? "Standing"
            : feature.creditRates !== undefined
              ? creditCost! > creditAvailable
                ? "Credits"
                : "Allowed"
              : headroom !== null && spec.amount > headroom
                ? "Ceiling"
                : overflow !== null
                  ? "Money"
                  : feature.overage === "block" &&
                      feature.remaining !== null &&
                      spec.amount > feature.remaining
                    ? "Remaining"
                    : "Allowed";
        if (verdict._tag !== expected) return false;

        switch (verdict._tag) {
          case "Standing":
            return spec.standing === "blocked";
          case "Allowed":
            if (spec.standing === "blocked") return false;
            if (feature.creditRates !== undefined) {
              return creditCost! <= creditAvailable;
            }
            if (headroom !== null && spec.amount > headroom) return false;
            if (overflow !== null) return false;
            if (
              feature.overage === "block" &&
              feature.remaining !== null &&
              spec.amount > feature.remaining
            ) {
              return false;
            }
            return true;
          case "Remaining":
            return (
              feature.overage === "block" &&
              feature.remaining !== null &&
              spec.amount > feature.remaining &&
              verdict.requested === spec.amount &&
              verdict.remaining === feature.remaining
            );
          case "Ceiling":
            return (
              feature.cap !== undefined &&
              headroom !== null &&
              spec.amount > headroom &&
              verdict.cap === feature.cap &&
              verdict.headroom === headroom &&
              verdict.requested === spec.amount
            );
          case "Money":
            return (
              feature.moneyCap !== undefined &&
              overflow !== null &&
              verdict.cap === feature.moneyCap &&
              verdict.billed === feature.billed &&
              verdict.promised === overflow.promised
            );
          case "Credits":
            return (
              feature.creditRates !== undefined &&
              creditCost === verdict.cost &&
              creditAvailable === verdict.available &&
              creditCost! > verdict.available
            );
        }
      },
      { runs: 300, size: 50 },
    ),
  );

  /**
   * A larger ask cannot become allowed when a smaller one was refused: every
   * rule is monotone in `amount`. This catches the ceiling a rule computes from
   * the wrong base (a cap that grows with the rollover, money that prices the
   * reserved units twice) without restating the arithmetic.
   */
  it.effect("a larger request is never allowed when a smaller one was refused", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          spec: FeatureSpec,
          large: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 400 }))),
        }),
      ),
      ({ spec, large }) => {
        const feature = featureOf(spec);
        const smallAmount = Math.min(spec.amount, large);
        const largeAmount = Math.max(spec.amount, large);
        const small = capacityOf({
          standing: spec.standing,
          feature,
          ask: askOf(smallAmount, spec.dimension),
        });
        const bigger = capacityOf({
          standing: spec.standing,
          feature,
          ask: askOf(largeAmount, spec.dimension),
        });
        // Allowed is downward-closed in `amount`, and refused is upward-closed.
        return !(bigger._tag === "Allowed" && small._tag !== "Allowed");
      },
      { runs: 200, size: 40 },
    ),
  );

  it.effect("the read model's one-unit reading is the same verdict", () =>
    assertProperty(
      Arbitrary.schema(FeatureSpec),
      (spec) => {
        const feature = featureOf(spec);
        // `allowsOne` is the read model's one-unit reading at the default
        // dimension: a view carries one `allowed` flag, not one per dimension.
        const verdict = capacityOf({
          standing: spec.standing,
          feature,
          ask: { amount: 1 },
        });
        const read = allowsOne(
          spec.standing as Standing,
          feature.overage as Overage,
          feature.remaining,
          feature.cap,
          feature.carried,
          {
            unitPrice: feature.unitPrice,
            moneyCap: feature.moneyCap,
            billed: feature.billed,
            used: feature.used,
            reserved: feature.reserved,
            included: feature.included,
          },
          feature.creditRates,
        );
        return read === (verdict._tag === "Allowed");
      },
      { runs: 200, size: 30 },
    ),
  );
});

describe("money overflow", () => {
  it.effect("the promised total is the independent billable arithmetic", () =>
    assertProperty(
      Arbitrary.schema(FeatureSpec),
      (spec) => {
        const feature = featureOf(spec);
        const overflow = moneyOverflowOf(feature, spec.amount);
        const promised = promisedOf(feature, spec.amount);
        if (feature.moneyCap === undefined) return overflow === null;
        const exceeded = feature.billed + promised > feature.moneyCap;
        if (!exceeded) return overflow === null;
        return (
          overflow !== null &&
          overflow.cap === feature.moneyCap &&
          overflow.billed === feature.billed &&
          overflow.promised === promised
        );
      },
      { runs: 300, size: 50 },
    ),
  );

  it.effect("a ceiling that refuses cannot start refusing a smaller request", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          spec: FeatureSpec,
          other: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 400 }))),
        }),
      ),
      ({ spec, other }) => {
        const feature = featureOf(spec);
        const small = Math.min(spec.amount, other);
        const large = Math.max(spec.amount, other);
        const atSmall = moneyOverflowOf(feature, small);
        const atLarge = moneyOverflowOf(feature, large);
        // Refusal is upward-closed, and the promised total is non-decreasing.
        if (atSmall !== null && atLarge === null) return false;
        if (atSmall !== null && atLarge !== null && atLarge.promised < atSmall.promised) {
          return false;
        }
        return true;
      },
      { runs: 200, size: 40 },
    ),
  );
});

const AllowanceSpec = Schema.Struct({
  included: IncludedSpec,
  overage: Schema.Literals(["block", "bill", "allow"]),
  cap: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  ),
  moneyCap: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20_000 }))),
  ),
});

const CountersSpec = Schema.Struct({
  used: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 500 }))),
  reserved: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 200 }))),
  billed: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20_000 }))),
});
type Counters = typeof CountersSpec.Type;

const sameCounters = (left: Counters, right: Counters): boolean =>
  left.used === right.used && left.reserved === right.reserved && left.billed === right.billed;

const countersAtLeast = (left: Counters, right: Counters): boolean =>
  left.used >= right.used && left.reserved >= right.reserved && left.billed >= right.billed;

describe("downgrade verdicts", () => {
  it.effect("names the first rule the move would break", () =>
    assertProperty(
      Arbitrary.schema(Schema.Struct({ allowance: AllowanceSpec, counters: CountersSpec })),
      ({ allowance, counters }) => {
        const verdict = downgradeOf(allowance, counters);
        const usage =
          allowance.overage === "block" &&
          allowance.included !== "unlimited" &&
          counters.used + counters.reserved > allowance.included;
        const spend = allowance.moneyCap !== undefined && counters.billed > allowance.moneyCap;
        const ceiling = spendCeilingOf(allowance);
        const overCeiling = ceiling !== null && counters.used + counters.reserved > ceiling;

        const expected = usage ? "Usage" : spend ? "Spend" : overCeiling ? "Ceiling" : "Allowed";
        if (verdict._tag !== expected) return false;

        switch (verdict._tag) {
          case "Allowed":
            return true;
          case "Usage":
            return (
              allowance.included !== "unlimited" &&
              typeof allowance.included === "number" &&
              verdict.included === allowance.included &&
              verdict.used === counters.used &&
              (verdict.reserved ?? 0) === counters.reserved
            );
          case "Spend":
            return (
              allowance.moneyCap !== undefined &&
              verdict.moneyCap === allowance.moneyCap &&
              verdict.billed === counters.billed
            );
          case "Ceiling":
            return (
              ceiling !== null &&
              verdict.ceiling === ceiling &&
              verdict.used === counters.used &&
              (verdict.reserved ?? 0) === counters.reserved
            );
        }
      },
      { runs: 300, size: 40 },
    ),
  );

  it.effect("more use, more holds or more spend never repairs a refused move", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          allowance: AllowanceSpec,
          small: CountersSpec,
          large: CountersSpec,
        }),
      ),
      ({ allowance, small, large }) => {
        const first = countersAtLeast(large, small)
          ? small
          : countersAtLeast(small, large)
            ? large
            : null;
        const second = first === small ? large : first === large ? small : null;
        // Two counters that are not comparable in both directions do not
        // constrain each other; skip that pair rather than claim an order.
        if (first === null || second === null) return true;
        if (sameCounters(first, second)) return true;

        const atFirst = downgradeOf(allowance, first);
        const atSecond = downgradeOf(allowance, second);
        // A move already refused cannot become allowed by consuming more.
        return atFirst._tag === "Allowed" || atSecond._tag !== "Allowed";
      },
      { runs: 200, size: 30 },
    ),
  );
});
