import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import { actionsFor, refundableCurrencies } from "../../src/AdminActions.ts";
import {
  SubscriptionStatus,
  initialSubscriptionState,
  refundableOf,
  type MoneyByCurrency,
  type SubscriptionState,
} from "../../src/Subscription/Subscription.state.ts";
import { assertProperty } from "../support/Property.ts";

const Currency = Schema.Literals(["usd", "eur", "gbp"]);

/**
 * Amounts biased toward zero and small values: the interesting cases are a
 * currency with no headroom and one with exactly a cent, which a uniform
 * range would almost never generate.
 */
const Cents = Schema.Union([
  Schema.Literal(0),
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 4, maximum: 500_000 }))),
]);

/** One generated money map, one key per currency the fixture sells in. */
const MoneySpec = Schema.Struct({
  usd: Schema.optionalKey(Cents),
  eur: Schema.optionalKey(Cents),
  gbp: Schema.optionalKey(Cents),
});

type MoneySpec = typeof MoneySpec.Type;

const Money = Schema.Struct({ charged: MoneySpec, refunded: MoneySpec });

const money = (spec: MoneySpec): MoneyByCurrency =>
  Object.fromEntries(
    Object.entries(spec).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );

const stateWith = (charged: MoneyByCurrency, refunded: MoneyByCurrency): SubscriptionState => ({
  ...initialSubscriptionState,
  charged,
  refunded,
});

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

describe("refundable currencies", () => {
  it.effect("offers exactly the currencies the model says have money left, sorted", () =>
    assertProperty(Arbitrary.schema(Money), ({ charged, refunded }) => {
      const state = stateWith(money(charged), money(refunded));
      const offered = refundableCurrencies(state.charged, state.refunded);

      // The console's list and the command's ceiling are the same arithmetic:
      // a currency is offered exactly when `refundableOf` has headroom.
      const expected = [...Currency.literals]
        .filter((currency) => refundableOf(state, currency) > 0)
        .sort();

      if (!same(offered, expected)) return false;

      if (new Set(offered).size !== offered.length) return false;

      return offered.every((currency) => {
        const headroom = (state.charged?.[currency] ?? 0) - (state.refunded?.[currency] ?? 0);

        return headroom > 0 && headroom === refundableOf(state, currency);
      });
    }),
  );

  it.effect("offers the refund action exactly when one currency is refundable, and last", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          charged: MoneySpec,
          refunded: MoneySpec,
          status: SubscriptionStatus,
        }),
      ),
      ({ charged, refunded, status }) => {
        const moneyCharged = money(charged);
        const moneyRefunded = money(refunded);

        const actions = actionsFor({
          status,
          tier: "pro",
          cancelAtPeriodEnd: false,
          charged: moneyCharged,
          refunded: moneyRefunded,
        });

        const refunds = actions.filter((descriptor) => descriptor.action === "Refund");
        const refundable = refundableCurrencies(moneyCharged, moneyRefunded).length > 0;

        if (refunds.length !== (refundable ? 1 : 0)) return false;

        // A refund is a money operation, not a standing move: when offered it
        // is always the last descriptor, whatever phase the standing is in.
        return !refundable || actions[actions.length - 1]?.action === "Refund";
      },
    ),
  );

  it("offers nothing when the account was never charged, or has nothing left to refund", () => {
    expect(refundableCurrencies(undefined, undefined)).toEqual([]);
    expect(refundableCurrencies({ usd: 0 }, undefined)).toEqual([]);
    expect(refundableCurrencies({ usd: 4_900 }, { usd: 4_900 })).toEqual([]);
    expect(refundableCurrencies({ usd: 4_900 }, { usd: 5_000 })).toEqual([]);
    expect(refundableCurrencies({ usd: 4_900 }, { usd: 1_000 })).toEqual(["usd"]);
  });
});
