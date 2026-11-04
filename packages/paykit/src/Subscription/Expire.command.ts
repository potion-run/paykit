import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { NotInGrace } from "./NotInGrace.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/** The standing is over; no further usage is allowed. */
export class SubscriptionExpired extends Domain.Event("SubscriptionExpired", {
  statusAfter: Schema.Literal("expired"),
}) {}

/** End a standing that is in grace. From expired it is a no-op. */
export class Expire extends Domain.Command("Expire", {
  target: AccountId,
  events: [SubscriptionExpired],
  rejects: [NotInGrace],
}) {}
