import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { AccountId } from "./Subscription.id.ts";

/**
 * One grant's deadline passed. The units leave the balance, and the event
 * records how many, so a replay reproduces the pool without reading the clock.
 */
export class BalanceExpired extends Domain.Event("BalanceExpired", {
  feature: Schema.String,
  grantId: Schema.String,
  amount: Schema.Int,
  /** The whole spendable count after the grant left. */
  balanceAfter: Schema.Int,
}) {}

/**
 * Expire a grant at its deadline. A scheduled caller fires only after
 * `expiresAt`; before it, for a grant that is already gone, or for one with no
 * deadline, the command records nothing. A policy schedules one per expiring
 * grant, keyed by the grant id.
 */
export class ExpireGrant extends Domain.Command("ExpireGrant", {
  target: AccountId,
  input: {
    feature: Schema.String,
    grantId: Schema.String,
  },
  events: [BalanceExpired],
  rejects: [],
}) {}
