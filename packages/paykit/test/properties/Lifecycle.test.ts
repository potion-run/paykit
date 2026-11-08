import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { tierTermsOf } from "../../src/Catalog.ts";
import { DunningRetry } from "../../src/Subscription/DunningRetry.command.ts";
import { Expire } from "../../src/Subscription/Expire.command.ts";
import { ExtendTrial } from "../../src/Subscription/ExtendTrial.command.ts";
import { GraceElapsed } from "../../src/Subscription/GraceElapsed.command.ts";
import { PeriodEnded } from "../../src/Subscription/PeriodEnded.command.ts";
import { RecordPayment } from "../../src/Subscription/RecordPayment.command.ts";
import { RecordPaymentFailure } from "../../src/Subscription/RecordPaymentFailure.command.ts";
import { Recover } from "../../src/Subscription/Recover.command.ts";
import { Resume } from "../../src/Subscription/Resume.command.ts";
import { ScheduleCancellation } from "../../src/Subscription/ScheduleCancellation.command.ts";
import { StartTrial } from "../../src/Subscription/StartTrial.command.ts";
import {
  initialSubscriptionState,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { assertProperty } from "../support/Property.ts";
import {
  commandOf,
  Days,
  decideAt,
  evolveAt,
  isAccepted,
  start,
  testCatalog,
  TrialDays,
} from "./Arbitraries.ts";

const Step = Schema.Union([
  Schema.TaggedStruct("RecordPayment", {}),
  Schema.TaggedStruct("RecordPaymentFailure", {}),
  Schema.TaggedStruct("Recover", {}),
  Schema.TaggedStruct("ScheduleCancellation", {}),
  Schema.TaggedStruct("Resume", {}),
  Schema.TaggedStruct("Expire", {}),
  Schema.TaggedStruct("GraceElapsed", {}),
  Schema.TaggedStruct("DunningRetry", {}),
  Schema.TaggedStruct("ExtendTrial", { trialDays: TrialDays }),
  Schema.TaggedStruct("PeriodEnded", {}),
]);

type Step = typeof Step.Type;

const LifecycleScript = Schema.Struct({
  open: Schema.Literals(["subscribe", "trial"]),
  tier: Schema.Literals(["free", "pro", "prepaid"]),
  steps: Schema.Array(
    Schema.Struct({
      step: Step,
      advanceDays: Days,
    }),
  ).pipe(Schema.check(Schema.isMaxLength(60))),
});

const commandFor = (step: Step, state: SubscribedState, now: DateTime.Utc) => {
  switch (step._tag) {
    case "RecordPayment":
      return new RecordPayment({ amount: 1_900, currency: "usd" });
    case "RecordPaymentFailure":
      return new RecordPaymentFailure({
        reason: "card_declined",
        graceUntil: DateTime.add(now, { days: 7 }),
      });
    case "Recover":
      return new Recover();
    case "ScheduleCancellation":
      return new ScheduleCancellation();
    case "Resume":
      return new Resume();
    case "Expire":
      return new Expire();
    case "GraceElapsed":
      return new GraceElapsed();
    case "DunningRetry":
      return new DunningRetry({
        afterAttempt: state.dunningAttempts,
        startedAt: state.dunningStartedAt ?? now,
      });
    case "ExtendTrial":
      return new ExtendTrial({ trialEndsAt: DateTime.add(now, { days: step.trialDays }) });
    case "PeriodEnded":
      return new PeriodEnded({ periodEnd: state.period.end });
  }
};

const expectedRejections: Record<Step["_tag"], ReadonlyArray<string>> = {
  RecordPayment: ["NotInGrace"],
  RecordPaymentFailure: [],
  Recover: ["NotInGrace"],
  ScheduleCancellation: ["AlreadyCanceled", "NotSubscribed"],
  Resume: ["NotScheduled", "NotSubscribed"],
  Expire: ["NotInGrace"],
  GraceElapsed: [],
  DunningRetry: [],
  ExtendTrial: ["TrialNotActive", "NotSubscribed", "TrialDeadlineNotLater"],
  PeriodEnded: [],
};

const opened = (script: typeof LifecycleScript.Type): SubscribedState => {
  const command =
    script.open === "trial"
      ? commandOf(
          { _tag: "StartTrial", tier: script.tier, trialDays: 7 },
          initialSubscriptionState,
          start,
        )
      : commandOf({ _tag: "Subscribe", tier: script.tier }, initialSubscriptionState, start);

  const decision = decideAt(initialSubscriptionState, command, start, "open");

  if (!isAccepted(decision)) throw new Error("the fixture catalog could not open a standing");
  const state = evolveAt(initialSubscriptionState, decision, start, "open");

  if (state._tag !== "Subscribed") throw new Error("opening did not activate a standing");

  return state;
};

describe("lifecycle", () => {
  it.effect("cancellation, grace and expiry stay typed and terminal", () =>
    assertProperty(
      Arbitrary.schema(LifecycleScript),
      (script) => {
        let state = opened(script);
        let now = start;

        for (const [index, { step, advanceDays }] of script.steps.entries()) {
          now = DateTime.add(now, { days: advanceDays });
          const before = state;
          const decision = decideAt(state, commandFor(step, state, now), now, `step-${index}`);

          if (!isAccepted(decision)) {
            if (!expectedRejections[step._tag].includes(decision._tag)) return false;

            // A refused extension is one that would not move the deadline
            // forward, so the requested day is at or before the one in force.
            if (step._tag === "ExtendTrial" && decision._tag === "TrialDeadlineNotLater") {
              if (before.trialEndsAt === undefined) return false;
              const requested = DateTime.add(now, { days: step.trialDays });

              if (DateTime.toEpochMillis(requested) > DateTime.toEpochMillis(before.trialEndsAt)) {
                return false;
              }
            }

            // A rejection changes nothing.
            if (state !== before) return false;
            continue;
          }

          if (decision.length === 0) {
            // Expiring an expired standing is a no-op; the other empty
            // decisions come from commands that declare no rejection.
            if (step._tag === "Expire") {
              if (before.status !== "expired") return false;
            } else if (expectedRejections[step._tag].length > 0) {
              return false;
            }

            continue;
          }

          const evolved = evolveAt(state, decision, now, `step-${index}`);

          if (evolved._tag !== "Subscribed") return false;
          const after = evolved;

          switch (step._tag) {
            case "RecordPayment":
            case "Recover":
              if (after.status !== "active" || after.graceUntil !== undefined) return false;
              break;
            case "RecordPaymentFailure":
              if (before.status === "expired" || before.status === "canceled") return false;

              if (after.status !== "grace") return false;

              if (after.dunningAttempts !== before.dunningAttempts + 1) return false;

              if (after.graceUntil === undefined) return false;
              break;
            case "ScheduleCancellation":
              if (!after.cancelAtPeriodEnd) return false;

              if (after.status !== before.status) return false;
              break;
            case "Resume":
              if (after.cancelAtPeriodEnd) return false;

              if (after.status !== before.status) return false;
              break;
            case "Expire":
              if (before.status !== "grace" || after.status !== "expired") return false;
              break;
            case "GraceElapsed": {
              const due =
                before.status === "grace" &&
                before.graceUntil !== undefined &&
                DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(before.graceUntil);

              if (due !== (after.status === "expired")) return false;
              break;
            }

            case "DunningRetry": {
              // A rung records only while it is still the current run, and it
              // never moves the standing out of grace by itself.
              if (after.status !== "grace") return false;

              if (decision[0]?._tag !== "DunningRetryDue") return false;
              break;
            }

            case "ExtendTrial": {
              if (before.status !== "trialing" || after.status !== "trialing") return false;
              const expected = DateTime.add(now, { days: step.trialDays });

              if (after.trialEndsAt === undefined) return false;

              if (DateTime.toEpochMillis(after.trialEndsAt) !== DateTime.toEpochMillis(expected)) {
                return false;
              }

              if (DateTime.toEpochMillis(after.period.end) !== DateTime.toEpochMillis(expected)) {
                return false;
              }

              break;
            }

            case "PeriodEnded": {
              if (decision[0]?._tag !== "PeriodClosed") return false;

              if (
                DateTime.toEpochMillis(after.period.start) !==
                DateTime.toEpochMillis(before.period.end)
              ) {
                return false;
              }

              if (after.usage.messages !== undefined) return false;

              const expectedStatus = before.cancelAtPeriodEnd
                ? "canceled"
                : before.status === "trialing"
                  ? "active"
                  : before.status;

              if (after.status !== expectedStatus) return false;
              const expectedCredits = before.creditsExpire === "period" ? 0 : before.credits;

              if (after.credits !== expectedCredits) return false;
              break;
            }
          }

          // Expiry is terminal: usage and recovery cannot revive it.
          if (after.status === "expired") {
            const usage = decideAt(
              after,
              new TrackUsage({ feature: "messages", amount: 1 }),
              now,
              "terminal-usage",
            );

            if (isAccepted(usage) || usage._tag !== "StandingBlocksUsage") return false;
            const recovery = decideAt(after, new Recover(), now, "terminal-recover");

            if (isAccepted(recovery) || recovery._tag !== "NotInGrace") return false;
          }

          state = after;
        }

        return true;
      },
      { runs: 80, size: 40 },
    ),
  );
});

const DeadlineDays = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: -400, maximum: 400 })),
);

describe("trial deadlines", () => {
  /**
   * A trial's deadline is the end of its first period, and everything
   * downstream reads it: `resetsAt`, the scheduled `PeriodEnded`, the close
   * that opens the next period. A deadline at or before `now` opens a period
   * that has already ended, and one that moves a running trial backwards
   * closes the period early — which is the opposite of what `ExtendTrial`
   * says it does.
   */
  it.effect("a trial opens forward, and an extension never moves it back", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          tier: Schema.Literals(["free", "pro", "unlimited", "metered"]),
          openDays: DeadlineDays,
          extendDays: DeadlineDays,
        }),
      ),
      ({ tier, openDays, extendDays }) => {
        const terms = tierTermsOf(testCatalog, tier);

        if (terms === null) return false;
        const now = start;
        const trialEndsAt = DateTime.add(now, { days: openDays });

        const opened = decideAt(
          initialSubscriptionState,
          new StartTrial({ tier, ...terms, trialEndsAt }),
          now,
          "open",
        );

        // A deadline that is not in the future may be refused. What it may not
        // do is open a period whose end is already behind it.
        if (!isAccepted(opened)) {
          return DateTime.toEpochMillis(trialEndsAt) <= DateTime.toEpochMillis(now);
        }

        const state = evolveAt(initialSubscriptionState, opened, now, "open");

        if (state._tag !== "Subscribed") return false;

        if (DateTime.toEpochMillis(state.period.end) !== DateTime.toEpochMillis(trialEndsAt)) {
          return false;
        }

        if (
          DateTime.toEpochMillis(state.period.end) <= DateTime.toEpochMillis(state.period.start)
        ) {
          return false;
        }

        const requested = DateTime.add(now, { days: extendDays });

        const extended = decideAt(
          state,
          new ExtendTrial({ trialEndsAt: requested }),
          now,
          "extend",
        );

        if (!isAccepted(extended)) {
          return DateTime.toEpochMillis(requested) <= DateTime.toEpochMillis(trialEndsAt);
        }

        const after = evolveAt(state, extended, now, "extend");

        if (after._tag !== "Subscribed") return false;

        // An extension reschedules the period, and never to an earlier end.
        if (
          DateTime.toEpochMillis(after.period.end) <= DateTime.toEpochMillis(after.period.start)
        ) {
          return false;
        }

        return DateTime.toEpochMillis(after.period.end) >= DateTime.toEpochMillis(state.period.end);
      },
      { runs: 120, size: 30 },
    ),
  );
});
