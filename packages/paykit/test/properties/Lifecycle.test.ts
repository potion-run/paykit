import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Expire } from "../../src/Subscription/Expire.command.ts";
import { ExtendTrial } from "../../src/Subscription/ExtendTrial.command.ts";
import { GraceElapsed } from "../../src/Subscription/GraceElapsed.command.ts";
import { PeriodEnded } from "../../src/Subscription/PeriodEnded.command.ts";
import { RecordPayment } from "../../src/Subscription/RecordPayment.command.ts";
import { RecordPaymentFailure } from "../../src/Subscription/RecordPaymentFailure.command.ts";
import { Recover } from "../../src/Subscription/Recover.command.ts";
import { Resume } from "../../src/Subscription/Resume.command.ts";
import { ScheduleCancellation } from "../../src/Subscription/ScheduleCancellation.command.ts";
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
  ExtendTrial: ["TrialNotActive", "NotSubscribed"],
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
