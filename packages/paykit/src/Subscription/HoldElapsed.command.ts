import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { UsageReleased } from "./ReleaseHold.command.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * The schedulable hold deadline: release a hold that is still open when its
 * `expiresAt` arrives. A hold settled or released first, an id nobody issued,
 * and a deadline that fires early all record nothing, so a policy can schedule
 * it without handling a rejection.
 */
export class HoldElapsed extends Domain.Command("HoldElapsed", {
  target: AccountId,
  input: { holdId: Schema.String },
  events: [UsageReleased],
  rejects: [],
}) {}
