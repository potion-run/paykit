import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { TierChanged } from "./ChangeTier.command.ts";
import { CreditsExpired, PeriodClosed, UsageReset } from "./ClosePeriod.command.ts";
import { UsageReleased } from "./ReleaseHold.command.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * The schedulable form of `ClosePeriod`: when the period is not over yet (or
 * was already closed) it records nothing, so a policy can schedule it without
 * handling a rejection.
 */
export class PeriodEnded extends Domain.Command("PeriodEnded", {
  target: AccountId,
  input: { periodEnd: Schema.DateTimeUtc },
  // A scheduled tier change lands before the reset, so the new tier's
  // allowances are the ones the next period starts on.
  events: [TierChanged, UsageReleased, PeriodClosed, UsageReset, CreditsExpired],
  rejects: [],
}) {}
