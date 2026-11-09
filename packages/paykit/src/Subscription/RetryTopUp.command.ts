import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Admin } from "../Auth/Guards.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * The budget for a failed refill allows one more attempt, and the wait is over.
 * It is a trigger rather than a fact about money: the policy buys the pack in
 * response, and what the attempt did is `CreditsPurchased` or `TopUpFailed`
 * (ADR 0031).
 */
export class TopUpRetryDue extends Domain.Event("TopUpRetryDue", {
  /** Which attempt this would become, counting the crossing's own. */
  attempt: Schema.Int,
}) {}

/**
 * Ask a standing that is still under its top-up line to try the refill again.
 *
 * Scheduled by the auto top-up policy `every` after a failure, while the tier's
 * budget allows. `decide` refuses to record it when the attempt it names is no
 * longer the standing's — a success or a newer failure moved the count — or when
 * the pool has recovered or a cooldown is open, so a stale deadline cannot
 * charge a card (ADR 0031).
 */
export class RetryTopUp extends Domain.Command("RetryTopUp", {
  target: AccountId,
  input: {
    /** The attempt this rung would become. */
    attempt: Schema.Int,
  },
  events: [TopUpRetryDue],
  rejects: [],
  middleware: [Admin],
}) {}
