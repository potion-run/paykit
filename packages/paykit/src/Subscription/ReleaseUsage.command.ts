import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Session } from "../Auth/Guards.ts";
import { NoReservation } from "./SettleUsage.command.ts";
import { AccountId } from "./Subscription.id.ts";

/** Held units came back, without recording usage. `remaining` grows again. */
export class UsageReleased extends Domain.Event("UsageReleased", {
  feature: Schema.String,
  amount: Schema.Int,
  reservedAfter: Schema.Int,
  remainingAfter: Schema.Int,
}) {}

/**
 * Return a held reservation without billing it: the work failed, was
 * cancelled, or cost less than it reserved. Releasing from an account that
 * holds nothing is refused rather than silently ignored, so a leaking
 * reservation shows up as an error instead of a shrinking allowance.
 */
export class ReleaseUsage extends Domain.Command("ReleaseUsage", {
  target: AccountId,
  input: {
    feature: Schema.String,
    amount: Schema.Int,
  },
  events: [UsageReleased],
  rejects: [NoReservation],
  middleware: [Session],
}) {}
