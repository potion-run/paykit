import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import {
  crossedThreshold,
  topUpCommandId,
  type CreditSpend,
} from "../../src/Subscription/AutoTopUp.policy.ts";
import { CreditsConsumed } from "../../src/Subscription/ConsumeCredits.command.ts";
import { UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import { assertProperty } from "../support/Property.ts";

const Credits = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20_000 })));
const Rate = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 })));

const SpendCase = Schema.Struct({
  /** The balance before the event, which the event itself has to reconstruct. */
  before: Credits,
  amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5_000 }))),
  rate: Rate,
  threshold: Credits,
  kind: Schema.Literals(["usage", "manual"]),
  /** A counted feature records usage without spending credits. */
  counted: Schema.Boolean,
});
type SpendCase = typeof SpendCase.Type;

/** The two spend shapes the policy listens to, with the balance before them. */
const spendOf = (input: SpendCase): { readonly before: number; readonly event: CreditSpend } => {
  if (input.kind === "manual") {
    return {
      before: input.before,
      event: new CreditsConsumed({
        amount: input.amount,
        balanceAfter: input.before - input.amount,
      }),
    };
  }
  const cost = input.counted ? 0 : input.amount * input.rate;
  return {
    before: input.before,
    event: new UsageRecorded({
      feature: "ai",
      amount: input.amount,
      cost,
      creditsAfter: input.before - cost,
      usedAfter: input.amount,
      remainingAfter: input.before - cost,
    }),
  };
};

describe("auto top-up crossing", () => {
  /**
   * A top-up is a crossing, not a level: the spend has to start above the
   * line and finish at or below it. A spend that starts below the line is
   * already past it, and one that lands above it has not reached it, so
   * neither may buy a pack. The event carries the balance before it, so the
   * policy can decide this without the aggregate or the clock.
   */
  it.effect("a spend crosses exactly when it starts above the line and lands at or below", () =>
    assertProperty(
      Arbitrary.schema(SpendCase),
      (input) => {
        const { before, event } = spendOf(input);
        const after = event._tag === "UsageRecorded" ? event.creditsAfter : event.balanceAfter;
        // A counted feature spends nothing, so it cannot move the pool.
        const moved = event._tag === "UsageRecorded" && event.cost <= 0 ? before : after;
        const expected = before > input.threshold && moved <= input.threshold;
        return crossedThreshold(event, input.threshold) === expected;
      },
      { runs: 200, size: 40 },
    ),
  );

  it.effect("a second spend below the line is not a second crossing", () =>
    assertProperty(
      Arbitrary.schema(SpendCase),
      (input) => {
        const { event } = spendOf(input);
        if (!crossedThreshold(event, input.threshold)) return true;
        const after = event._tag === "UsageRecorded" ? event.creditsAfter : event.balanceAfter;
        // The next spend starts exactly where this one finished: already at
        // or below the line, so it cannot cross it again.
        const next =
          event._tag === "UsageRecorded"
            ? new UsageRecorded({
                feature: "ai",
                amount: 1,
                cost: 1,
                creditsAfter: after - 1,
                usedAfter: 2,
                remainingAfter: after - 1,
              })
            : new CreditsConsumed({ amount: 1, balanceAfter: after - 1 });
        return !crossedThreshold(next, input.threshold);
      },
      { runs: 100, size: 30 },
    ),
  );
});

const CommandIdCase = Schema.Struct({
  account: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(24)),
  ),
  otherAccount: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(24)),
  ),
  seq: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))),
  otherSeq: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))),
});

describe("the auto top-up command id", () => {
  /**
   * The invoice and the purchase share one id, and the id names the crossing:
   * the account and the event's sequence. Two crossings must never collapse
   * into one purchase, and a redelivery of one crossing must never look like
   * another. Account ids are caller data, so the separator cannot be the only
   * thing keeping two accounts apart.
   */
  it.effect("names exactly one crossing, even when account ids contain separators", () =>
    assertProperty(
      Arbitrary.schema(CommandIdCase),
      ({ account, otherAccount, seq, otherSeq }) => {
        const first = topUpCommandId(account, seq);
        const second = topUpCommandId(otherAccount, otherSeq);
        const sameCrossing = account === otherAccount && seq === otherSeq;
        if ((first === second) !== sameCrossing) return false;
        // The id is stable for the same crossing, which is what makes a
        // redelivery the same invoice.
        return topUpCommandId(account, seq) === first;
      },
      { runs: 120, size: 30 },
    ),
  );
});
