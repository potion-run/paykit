import * as Domain from "@alchemy.run/domain";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { TierChanged } from "./ChangeTier.command.ts";
import { AllowanceReset, ResetAllowance } from "./ResetAllowance.command.ts";
import { TrialStarted } from "./StartTrial.command.ts";
import { SubscriptionActivated } from "./Subscribe.command.ts";
import { Subscription } from "./Subscription.aggregate.ts";

/**
 * Whenever an allowance that runs on its own schedule opens a window, schedule
 * its close. A monthly or annual allowance follows the standing's period and is
 * reset by `ClosePeriod`; a daily, weekly or quarterly one has a boundary the
 * period does not own, so this is what makes that boundary happen.
 *
 * The chain is the same shape as `PeriodRollover`: a reset schedules the next
 * one, so a schedule is a chain rather than a cron.
 */
export class AllowanceRollover extends Domain.Policy("AllowanceRollover", {
  from: Subscription,
  on: [SubscriptionActivated, TrialStarted, TierChanged, AllowanceReset],
}) {}

export const AllowanceRolloverLive = AllowanceRollover.toLayer(
  Effect.gen(function* () {
    const subscriptions = yield* Subscription;

    return Effect.fn("Paykit.AllowanceRollover.react")(function* ({ key, event }) {
      const entries: ReadonlyArray<readonly [string, DateTime.Utc]> =
        event._tag === "AllowanceReset"
          ? event.resetAt === null
            ? []
            : [[event.feature, event.resetAt]]
          : Object.entries(event.resetAt ?? {});

      for (const [feature, at] of entries) {
        yield* subscriptions
          .schedule(key, new ResetAllowance({ feature, at }), {
            at,
            commandId: `allowance-reset:${feature}:${at.epochMilliseconds}`,
          })
          .pipe(Effect.catchTag("AlreadyExecuted", () => Effect.void));
      }
    });
  }),
);
