import * as Domain from "@alchemy.run/domain";
import { AccountId } from "./Subscription.id.ts";

/**
 * The cooldown a top-up opened has ended, so the pool may buy the next pack
 * again. Recorded by the deadline command and folded into the standing's
 * `topUpCooldownUntil`; the deadline itself is on the `CreditsPurchased` event
 * that started it.
 */
export class TopUpCooldownCleared extends Domain.Event("TopUpCooldownCleared") {}

/**
 * The schedulable end of a top-up cooldown: clear the standing's deadline once
 * the clock reaches it. A standing with no cooldown, and a deadline that fires
 * early, record nothing, so a policy can schedule it without handling a
 * rejection.
 *
 * This is the same shape as `HoldElapsed` and `GraceElapsed`: a deadline is a
 * command so the decision is replayable, and `decide` reads the clock from its
 * context rather than the policy reading it before the command exists.
 */
export class TopUpCooldownElapsed extends Domain.Command("TopUpCooldownElapsed", {
  target: AccountId,
  events: [TopUpCooldownCleared],
  rejects: [],
}) {}
