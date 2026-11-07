import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { AccountId } from "./Subscription.id.ts";

/**
 * A dunning retry is due. The policy reacts by charging the account's saved
 * method; the event records the attempt and the money it asked for, so a
 * replay reproduces what was tried without reading a catalog or a clock.
 */
export class DunningRetryDue extends Domain.Event("DunningRetryDue", {
  /** The attempt this retry will become if it fails. */
  attempt: Schema.Int,
  /** The first failure that started this dunning run. */
  startedAt: Schema.DateTimeUtc,
  /** What the standing's price was when the retry became due. */
  amount: Schema.Int,
  currency: Schema.String,
}) {}

/**
 * The schedulable retry point of a dunning ladder. It records
 * `DunningRetryDue` only while the standing is still in grace and this is
 * still the failure the deployment scheduled a retry after; an earlier
 * recovery, a newer failure or a passed grace deadline makes it a no-op.
 */
export class DunningRetry extends Domain.Command("DunningRetry", {
  target: AccountId,
  input: {
    /** The attempt count the ladder scheduled this retry after. */
    afterAttempt: Schema.Int,
    /** The first failure of the run, so an old schedule cannot act on a new one. */
    startedAt: Schema.DateTimeUtc,
  },
  events: [DunningRetryDue],
  rejects: [],
}) {}
