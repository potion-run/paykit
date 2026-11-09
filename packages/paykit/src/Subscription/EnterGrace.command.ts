import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Admin } from "../Auth/Guards.ts";
import { NotInGrace } from "./NotInGrace.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/** The account is already in grace; extend it with `RecordPaymentFailure`. */
export class AlreadyInGrace extends Domain.Rejection("AlreadyInGrace") {}

/**
 * The grace deadline is not after now. A window that opens already lapsed is
 * a standing the clock would expire on the next tick; a deadline has to move
 * service forward, the way a trial's does.
 */
export class GraceDeadlineNotLater extends Domain.Rejection("GraceDeadlineNotLater", {
  current: Schema.DateTimeUtc,
  requested: Schema.DateTimeUtc,
}) {}

/** The account entered grace and keeps service until the deadline. */
export class GraceEntered extends Domain.Event("GraceEntered", {
  graceUntil: Schema.DateTimeUtc,
  statusAfter: Schema.Literal("grace"),
}) {}

/** Put an account in grace without a payment failure, e.g. from the console. */
export class EnterGrace extends Domain.Command("EnterGrace", {
  target: AccountId,
  input: { graceUntil: Schema.DateTimeUtc },
  events: [GraceEntered],
  rejects: [AlreadyInGrace, NotSubscribed, NotInGrace, GraceDeadlineNotLater],
  middleware: [Admin],
}) {}
