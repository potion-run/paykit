import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import { CreditsPurchased } from "../../src/Subscription/PurchaseCredits.command.ts";
import {
  Refund,
  RefundExceedsCharged,
  type RefundRecorded,
} from "../../src/Subscription/Refund.command.ts";
import {
  chargedOf,
  refundableOf,
  refundedOf,
  type SubscriptionState,
} from "../../src/Subscription/Subscription.state.ts";
import { assertProperty } from "../support/Property.ts";
import { decideAt, evolveAt, isAccepted, start, subscribedAt } from "./Arbitraries.ts";

const Currency = Schema.Literals(["usd", "eur"]);
const Money = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })));

/** A price: `Price.amount` is positive, so a generated charge has to be too. */
const PositiveMoney = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
);

/**
 * One step of a money history: something was charged, or the operator asked for
 * money back. A refund names the currency it is in, so an account with two
 * currencies has two ceilings.
 */
const Op = Schema.Union([
  Schema.TaggedStruct("Charge", { currency: Currency, amount: PositiveMoney }),
  Schema.TaggedStruct("Refund", {
    currency: Currency,
    amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -10, maximum: 200_000 }))),
  }),
  // Refund exactly what is left, so the ceiling's boundary is exercised
  // rather than approached: a rule that refuses `<=` instead of `<` has to fail.
  Schema.TaggedStruct("RefundRest", { currency: Currency }),
]);

const Script = Schema.Struct({
  ops: Schema.Array(Op).pipe(Schema.check(Schema.isMaxLength(10))),
});

type Script = typeof Script.Type;

const priceOf = (currency: string, amount: number) =>
  ({ amount, currency, interval: "month" }) as const;

describe("the refund ceiling", () => {
  /**
   * A refund is accepted exactly when it fits under what the account was
   * charged in its currency, less what already went back — and a non-positive
   * refund records nothing. The ceiling is checked against the refundable
   * amount computed here, independently of the decider.
   */
  it.effect("accepts exactly what fits, and never more than was charged", () =>
    assertProperty(
      Arbitrary.schema(Script),
      ({ ops }) => {
        let state: SubscriptionState = subscribedAt("pro");

        for (const [index, op] of ops.entries()) {
          if (op._tag === "Charge") {
            const event = new CreditsPurchased({
              tier: "pack",
              amount: 0,
              price: priceOf(op.currency, op.amount),
              balanceAfter: 0,
              prepaidAfter: 0,
            });

            state = evolveAt(state, [event], start, `charge-${index}`);
          } else {
            const before = refundableOf(state, op.currency);
            const amount = op._tag === "RefundRest" ? before : op.amount;

            const decision = decideAt(
              state,
              new Refund({
                chargeId: `ch_${index}`,
                refundId: `re_${index}`,
                amount,
                currency: op.currency,
              }),
              start,
              `refund-${index}`,
            );

            // A non-positive refund is an accepted command that records nothing;
            // a refund past the ceiling is a typed refusal. Only a refund that
            // fits records an event, which is the dispose the property pins.
            const fits = amount > 0 && amount <= before;
            const recorded = isAccepted(decision) && decision.length > 0;

            if (recorded !== fits) return false;

            if (recorded) {
              const event = decision[0] as RefundRecorded;

              if (event._tag !== "RefundRecorded") return false;

              // The event is the evidence: the refund's own numbers, and the
              // currency's total after it.
              if (event.amount !== amount || event.currency !== op.currency) return false;

              if (event.refundedAfter !== (refundedOf(state)[op.currency] ?? 0) + amount) {
                return false;
              }

              state = evolveAt(state, decision, start, `refund-${index}`);
            } else if (amount > 0) {
              if (!Schema.is(RefundExceedsCharged)(decision)) return false;

              // A refusal changes nothing.
              if (decision.requested !== amount) return false;
            } else if (!isAccepted(decision)) {
              return false;
            }
          }

          // The invariant, after every step: money back never exceeds money in.
          for (const currency of ["usd", "eur"] as const) {
            if ((refundedOf(state)[currency] ?? 0) > (chargedOf(state)[currency] ?? 0))
              return false;
          }
        }

        return true;
      },
      { runs: 150, size: 40 },
    ),
  );

  /**
   * The ceiling is per currency: charging in dollars leaves a euro refund with
   * nothing to spend, so one currency's refunds cannot eat another's headroom.
   */
  it.effect("keeps one currency's refunds out of another currency's ceiling", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          charged: Money,
          refunded: Schema.Int.pipe(
            Schema.check(Schema.isBetween({ minimum: 0, maximum: 200_000 })),
          ),
        }),
      ),
      ({ charged, refunded }) => {
        const state = {
          ...subscribedAt("pro"),
          charged: { usd: charged },
          refunded: { usd: refunded },
        };

        const decision = decideAt(
          state,
          new Refund({ chargeId: "ch_1", refundId: "re_1", amount: 1, currency: "eur" }),
          start,
          "euro-refund",
        );

        // One euro cent is still more than the zero euros charged.
        return !isAccepted(decision) && Schema.is(RefundExceedsCharged)(decision);
      },
      { runs: 60, size: 20 },
    ),
  );
});
