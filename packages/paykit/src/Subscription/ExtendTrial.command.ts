import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Admin } from "../Auth/Guards.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/** The account is not on a trial, so there is nothing to extend. */
export class TrialNotActive extends Domain.Rejection("TrialNotActive") {}

/** The trial now ends later, and so does its period. */
export class TrialExtended extends Domain.Event("TrialExtended", {
  trialEndsAt: Schema.DateTimeUtc,
  periodEnd: Schema.DateTimeUtc,
}) {}

/** Extend a running trial from the console. */
export class ExtendTrial extends Domain.Command("ExtendTrial", {
  target: AccountId,
  input: { trialEndsAt: Schema.DateTimeUtc },
  events: [TrialExtended],
  rejects: [NotSubscribed, TrialNotActive],
  middleware: [Admin],
}) {}
