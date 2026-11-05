import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Session } from "../Auth/Guards.ts";
import { HoldSettled, HoldUnknown } from "./Hold.command.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * Held units (or credits) came back without being billed. `amount` is what
 * returns and `cost` is the credits the hold kept out of the pool, so the
 * shared balance is whole again.
 */
export class UsageReleased extends Domain.Event("UsageReleased", {
  holdId: Schema.String,
  feature: Schema.String,
  amount: Schema.Int,
  /** Credits the hold reserved; `0` for a feature counted in its own units. */
  cost: Schema.Int,
  remainingAfter: Schema.NullOr(Schema.Int),
}) {}

/**
 * Return a hold without billing it: the work failed, was cancelled, or never
 * ran. Releasing after `expiresAt` still returns the units, because a late
 * release is a cleanup and not a charge. Releasing a settled hold is
 * `HoldSettled` — the units were billed, so there is nothing to give back —
 * and an id nobody issued is `HoldUnknown`.
 */
export class ReleaseHold extends Domain.Command("ReleaseHold", {
  target: AccountId,
  input: { holdId: Schema.String },
  events: [UsageReleased],
  rejects: [HoldUnknown, HoldSettled],
  // The units this release returned, from the event it committed.
  reply: { released: Schema.Int },
  middleware: [Session],
}) {}
