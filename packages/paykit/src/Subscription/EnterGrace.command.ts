import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Admin } from "../Auth/Guards.ts";
import { NotInGrace } from "./NotInGrace.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/** The account is already in grace; extend it with `RecordPaymentFailure`. */
export class AlreadyInGrace extends Domain.Rejection("AlreadyInGrace") {}

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
  rejects: [AlreadyInGrace, NotSubscribed, NotInGrace],
  middleware: [Admin],
}) {}
