import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { CreditsExpired, PeriodClosed, UsageReset } from "./ClosePeriod.command.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * The schedulable form of `ClosePeriod`: when the period is not over yet (or
 * was already closed) it records nothing, so a policy can schedule it without
 * handling a rejection.
 */
export class PeriodEnded extends Domain.Command("PeriodEnded", {
  target: AccountId,
  input: { periodEnd: Schema.DateTimeUtc },
  events: [PeriodClosed, UsageReset, CreditsExpired],
  rejects: [],
}) {}
