import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { type Allowance } from "../../src/Allowance.ts";
import { messages } from "../../src/Feature.ts";
import {
  addInterval,
  creditRateOf,
  includedRemainingOf,
  periodFrom,
  resetOf,
  spendCeilingOf,
  spendHeadroomOf,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { assertProperty } from "../support/Property.ts";
import { rawAllowance as allowance, rawGrant as grant } from "../support/Raw.ts";

const IncludedSpec = Schema.Union([
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  Schema.Literal("unlimited"),
]);

const AllowanceSpec = Schema.Struct({
  kind: Schema.Literals(["metered", "flag"]),
  included: IncludedSpec,
  overage: Schema.Literals(["block", "bill", "allow"]),
  resets: Schema.Literals(["month", "annual", "never"]),
  carryOver: Schema.Boolean,
});
type AllowanceSpec = typeof AllowanceSpec.Type;

const buildAllowance = (spec: AllowanceSpec): Allowance => {
  if (spec.kind === "flag") return grant(messages);
  return allowance(messages, {
    included: spec.included,
    overage: spec.included === "unlimited" ? "allow" : spec.overage,
    resets: spec.resets,
    carryOver: spec.carryOver && spec.resets !== "never",
  });
};

/**
 * `resetOf` reads only the recorded count and the allowance. Building the two
 * fields directly keeps the property about the rollover algebra rather than
 * about the command that produced the count.
 */
const stateAt = (allowance: Allowance, remaining: number | null | undefined): SubscribedState =>
  ({
    allowances: { messages: allowance },
    remaining: remaining === undefined ? {} : { messages: remaining },
  }) as unknown as SubscribedState;

describe("allowance algebra", () => {
  it.effect("a rollover carries at most what the period included, and never a debt", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          allowance: AllowanceSpec,
          current: Schema.Union([
            Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -200, maximum: 300 }))),
            Schema.Literal("fallback"),
          ]),
        }),
      ),
      ({ allowance: spec, current: script }) => {
        const built = buildAllowance(spec);
        const state = stateAt(built, script === "fallback" ? undefined : script);
        const reset = resetOf(state, "messages", built);
        const included = includedRemainingOf(built);

        // A flag or an unlimited allowance has no count to carry.
        if (included === null) {
          return reset.remaining === null && reset.carried === 0;
        }
        // A `resets: "never"` feature keeps its usage and remainder across
        // the boundary; the close is a no-op for it.
        if (built.resets === "never") {
          const current = script === "fallback" ? included : script;
          return reset.kept === true && reset.carried === 0 && reset.remaining === current;
        }
        // A period that does not carry starts exactly at what it includes.
        if (built.carryOver !== true) {
          return reset.kept === false && reset.remaining === included && reset.carried === 0;
        }

        const spendable = script === "fallback" ? included : script;
        const expected = Math.min(Math.max(spendable, 0), included);
        return (
          reset.kept === false &&
          reset.carried === expected &&
          reset.remaining === included + expected &&
          reset.carried >= 0 &&
          reset.carried <= included &&
          reset.remaining >= included &&
          reset.remaining <= included * 2
        );
      },
      { runs: 120, size: 30 },
    ),
  );

  it.effect("a rollover does not widen a cap", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          included: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))),
          cap: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
          carried: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))),
          used: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))),
          reserved: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))),
        }),
      ),
      ({ included, cap, carried, used, reserved }) => {
        // `remaining` is what a read model holds: included + carried, less use
        // and open reservations. The cap is on the period's units, not on the
        // rollover, so the headroom is `included + cap - used - reserved`.
        const remaining = included + carried - used - reserved;
        const headroom = spendHeadroomOf({ remaining, cap, carried });
        if (headroom !== included + cap - used - reserved) return false;
        // The same period with no carry has the same headroom: carrying does
        // not buy extra billed units.
        return spendHeadroomOf({ remaining: included - used - reserved, cap }) === headroom;
      },
      { runs: 120, size: 30 },
    ),
  );

  it("states a ceiling only where there is a cap and a count", () => {
    expect(spendCeilingOf({ included: 100, overage: "bill", cap: 20 })).toBe(120);
    expect(spendCeilingOf({ included: 100, overage: "bill" })).toBe(null);
    expect(spendCeilingOf({ included: "unlimited", overage: "allow", cap: 20 })).toBe(null);
    expect(spendCeilingOf({ included: null, overage: "bill", cap: 20 })).toBe(null);
  });
});

describe("calendar", () => {
  it.effect("a period always moves forward by one cadence", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          start: Schema.Int.pipe(
            Schema.check(
              Schema.isBetween({ minimum: 1_577_836_800_000, maximum: 1_893_456_000_000 }),
            ),
          ),
          interval: Schema.Literals(["month", "annual"]),
          anchorTz: Schema.Literals(["UTC", "America/New_York", "Asia/Kolkata"]),
        }),
      ),
      ({ start, interval, anchorTz }) => {
        const at = DateTime.makeUnsafe(start);
        const period = periodFrom(at, interval, anchorTz);
        if (DateTime.toEpochMillis(period.end) <= DateTime.toEpochMillis(period.start))
          return false;
        if (period.anchorTz !== anchorTz) return false;
        // The next interval from the end is still after the end, however the
        // calendar clamps a month end.
        if (
          DateTime.toEpochMillis(addInterval(period.end, interval)) <=
          DateTime.toEpochMillis(period.end)
        ) {
          return false;
        }
        return true;
      },
      { runs: 100, size: 30 },
    ),
  );
});

describe("credit rates", () => {
  it.effect("a named dimension wins, and every other name falls back to default", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          defaultRate: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
          named: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
          dimension: Schema.Literals(["gpt-large", "unknown"]),
        }),
      ),
      ({ defaultRate, named, dimension }) => {
        const rates = { default: defaultRate, "gpt-large": named };
        if (creditRateOf(rates, undefined) !== defaultRate) return false;
        if (creditRateOf(rates, "default") !== defaultRate) return false;
        if (creditRateOf(rates, "gpt-large") !== named) return false;
        return creditRateOf(rates, dimension) === (dimension === "gpt-large" ? named : defaultRate);
      },
      { runs: 80, size: 20 },
    ),
  );

  it("an empty card prices nothing", () => {
    expect(creditRateOf({}, "default")).toBe(0);
    expect(includedRemainingOf({ included: 1 })).toBe(1);
  });
});
