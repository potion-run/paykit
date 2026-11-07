import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import {
  crossedThreshold,
  packFor,
  topUpCooldownCommandId,
  topUpCooldownFor,
  topUpCommandId,
  type CreditSpend,
} from "../../src/Subscription/AutoTopUp.policy.ts";
import { CreditsConsumed } from "../../src/Subscription/ConsumeCredits.command.ts";
import {
  CreditsPurchased,
  PurchaseCredits,
} from "../../src/Subscription/PurchaseCredits.command.ts";
import {
  initialSubscriptionState,
  topUpCooldownOf,
} from "../../src/Subscription/Subscription.state.ts";
import {
  TopUpCooldownCleared,
  TopUpCooldownElapsed,
} from "../../src/Subscription/TopUpCooldownElapsed.command.ts";
import { UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import { assertProperty } from "../support/Property.ts";
import { decideAt, evolveAt, isAccepted, start, subscribedAt } from "./Arbitraries.ts";

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

/**
 * The cooldown is a deadline, not a level: the command fires on a schedule and
 * `decide` reads the clock from its context, so the same standing decides the
 * same way on a replay. A fire before the deadline, a standing that never
 * opened a cooldown, and a pool with no standing all record nothing.
 */
const Deadline = Schema.Struct({
  cooldownMinutes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_440 }))),
  elapsedMinutes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 2_880 }))),
});

describe("the top-up cooldown deadline", () => {
  it.effect("clears at the deadline it was scheduled for, and never before", () =>
    assertProperty(
      Arbitrary.schema(Deadline),
      ({ cooldownMinutes, elapsedMinutes }) => {
        const until = DateTime.addDuration(start, Duration.minutes(cooldownMinutes));
        const state = { ...subscribedAt("pro"), topUpCooldownUntil: until };
        const now = DateTime.addDuration(start, Duration.minutes(elapsedMinutes));
        const decision = decideAt(state, new TopUpCooldownElapsed(), now, "deadline");
        if (!isAccepted(decision)) return false;
        const cleared = decision.length === 1 && decision[0]!._tag === "TopUpCooldownCleared";
        // At or after the deadline is cleared; a fire one minute early (or
        // more) records nothing, so a platform that runs schedules eagerly
        // cannot end a cooldown the deployment asked for.
        return cleared === elapsedMinutes >= cooldownMinutes;
      },
      { runs: 150, size: 30 },
    ),
  );

  it.effect("records nothing for a standing that opened no cooldown", () =>
    assertProperty(
      Arbitrary.schema(Deadline),
      ({ elapsedMinutes }) => {
        const now = DateTime.addDuration(start, Duration.minutes(elapsedMinutes));
        const cleared = decideAt(subscribedAt("pro"), new TopUpCooldownElapsed(), now, "deadline");
        const unopened = decideAt(
          initialSubscriptionState,
          new TopUpCooldownElapsed(),
          now,
          "deadline",
        );
        return (
          isAccepted(cleared) &&
          cleared.length === 0 &&
          isAccepted(unopened) &&
          unopened.length === 0
        );
      },
      { runs: 60, size: 20 },
    ),
  );
});

/**
 * The standing is a fold: a purchase that carries a deadline sets it, a
 * purchase a checkout completed (no deadline) leaves it alone, and a cleared
 * event removes it. Whatever the order, the field is the last deadline set
 * before the last clear — which is what makes a replay of the same log agree.
 */
const CooldownOp = Schema.Union([
  Schema.TaggedStruct("Purchase", {
    cooldownMinutes: Schema.optionalKey(
      Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_440 }))),
    ),
  }),
  Schema.TaggedStruct("Clear", {}),
]);
const CooldownScript = Schema.Struct({
  ops: Schema.Array(CooldownOp).pipe(Schema.check(Schema.isMaxLength(12))),
});

describe("the cooldown as a fold", () => {
  it.effect("keeps the last deadline set before the last clear, and nothing after one", () =>
    assertProperty(
      Arbitrary.schema(CooldownScript),
      ({ ops }) => {
        let expected: DateTime.Utc | undefined;
        const events: Array<CreditsPurchased | TopUpCooldownCleared> = [];
        for (const op of ops) {
          if (op._tag === "Clear") {
            expected = undefined;
            events.push(new TopUpCooldownCleared());
            continue;
          }
          const until =
            op.cooldownMinutes === undefined
              ? undefined
              : DateTime.addDuration(start, Duration.minutes(op.cooldownMinutes));
          if (until !== undefined) expected = until;
          events.push(
            new CreditsPurchased({
              tier: "pack",
              amount: 10,
              balanceAfter: 10,
              prepaidAfter: 10,
              ...(until === undefined ? {} : { cooldownUntil: until }),
            }),
          );
        }
        const state = evolveAt(subscribedAt("pro"), events, start, "fold");
        const observed = topUpCooldownOf(state);
        return (
          (observed === null ? undefined : DateTime.toEpochMillis(observed)) ===
          (expected === undefined ? undefined : DateTime.toEpochMillis(expected))
        );
      },
      { runs: 120, size: 20 },
    ),
  );
});

/**
 * The invoice and the deadline are two commands on one crossing, so their ids
 * must not collide: a platform keying both by command id would otherwise treat
 * the deadline as a retry of the purchase. Each is stable per crossing and
 * distinct per crossing, for the same reason the invoice id is.
 */
const CrossingId = Schema.Struct({
  account: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  seq: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))),
  otherSeq: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))),
});

describe("the cooldown command id", () => {
  it.effect("names one deadline, distinct from the crossing's own purchase", () =>
    assertProperty(
      Arbitrary.schema(CrossingId),
      ({ account, seq, otherSeq }) => {
        const deadline = topUpCooldownCommandId(account, seq);
        if (deadline === topUpCommandId(account, seq)) return false;
        if (topUpCooldownCommandId(account, seq) !== deadline) return false;
        return (deadline === topUpCooldownCommandId(account, otherSeq)) === (seq === otherSeq);
      },
      { runs: 100, size: 20 },
    ),
  );
});

/**
 * The money and the credits are one record, so the purchase event has to carry
 * exactly the reference it was given: an invoice, a charge, or neither — never
 * both, and never one the command did not name. The cooldown deadline is the
 * clock's, and the field is absent when the deployment asked for none.
 */
const PurchaseCase = Schema.Struct({
  amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }))),
  before: Credits,
  cooldownMinutes: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_440 }))),
  ),
  money: Schema.Union([
    Schema.TaggedStruct("Invoice", { id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))) }),
    Schema.TaggedStruct("Charge", { id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))) }),
    Schema.TaggedStruct("None", {}),
  ]),
});

describe("the purchase records the money it was given", () => {
  it.effect("carries the one reference the command named, and the deadline it opened", () =>
    assertProperty(
      Arbitrary.schema(PurchaseCase),
      ({ amount, before, cooldownMinutes, money }) => {
        const state = { ...subscribedAt("pro"), credits: before };
        const until =
          cooldownMinutes === undefined
            ? undefined
            : DateTime.addDuration(start, Duration.minutes(cooldownMinutes));
        const command = new PurchaseCredits({
          tier: "pack",
          amount,
          ...(money._tag === "Invoice" ? { invoiceId: money.id } : {}),
          ...(money._tag === "Charge" ? { chargeId: money.id } : {}),
          ...(until === undefined ? {} : { cooldownUntil: until }),
        });
        const decision = decideAt(state, command, start, "crossing");
        if (!isAccepted(decision) || decision.length !== 1) return false;
        const event = decision[0] as CreditsPurchased;
        if (event._tag !== "CreditsPurchased") return false;
        const invoice = money._tag === "Invoice" ? money.id : undefined;
        const charge = money._tag === "Charge" ? money.id : undefined;
        if (event.invoiceId !== invoice || event.chargeId !== charge) return false;
        if (event.balanceAfter !== before + amount) return false;
        const opened = event.cooldownUntil;
        return (
          (opened === undefined ? undefined : DateTime.toEpochMillis(opened)) ===
          (until === undefined ? undefined : DateTime.toEpochMillis(until))
        );
      },
      { runs: 150, size: 30 },
    ),
  );
});

describe("the pack and the bound a standing's line selects", () => {
  const fallback = {
    tier: "pack",
    amount: 5_000,
    price: { amount: 4_900, currency: "usd", interval: "month" as const },
  };
  const small = {
    tier: "pack_small",
    amount: 100,
    price: { amount: 990, currency: "usd", interval: "month" as const },
  };
  const terms = {
    fallback,
    packs: new Map([["pack_small", small]]),
    rates: {},
    cooldown: Duration.minutes(30),
  };

  it("buys the deployment's pack when the tier names none", () => {
    expect(packFor(terms, undefined)).toEqual(fallback);
  });

  it("buys the pack the tier names", () => {
    expect(packFor(terms, "pack_small")).toEqual(small);
  });

  it("answers nothing for a name the layer never resolved, rather than a different pack", () => {
    // The catalog refuses such a name, so a miss means the standing and the
    // catalog disagreed; buying the fallback would silently sell the wrong
    // product at the wrong price.
    expect(packFor(terms, "pack_1m")).toBeNull();
  });

  it("prefers the tier's cooldown, then the deployment's, then none", () => {
    expect(topUpCooldownFor(terms, { threshold: 0, cooldown: Duration.hours(1) })).toEqual(
      Duration.hours(1),
    );
    expect(topUpCooldownFor(terms, { threshold: 0 })).toEqual(Duration.minutes(30));
    expect(topUpCooldownFor({ ...terms, cooldown: null }, { threshold: 0 })).toBeNull();
  });
});
