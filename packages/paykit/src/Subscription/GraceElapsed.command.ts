import * as Domain from "@alchemy.run/domain";
import { SubscriptionExpired } from "./Expire.command.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * The schedulable grace deadline: expire only while the account is still in
 * grace. A recovery before the deadline makes this a no-op.
 */
export class GraceElapsed extends Domain.Command("GraceElapsed", {
  target: AccountId,
  events: [SubscriptionExpired],
  rejects: [],
}) {}
