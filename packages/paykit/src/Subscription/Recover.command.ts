import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Admin } from "../Auth/Guards.ts";
import { NotInGrace } from "./NotInGrace.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/** The account is active again and its grace deadline is cleared. */
export class Recovered extends Domain.Event("Recovered", {
  statusAfter: Schema.Literal("active"),
}) {}

/** Leave grace without recording a specific payment. */
export class Recover extends Domain.Command("Recover", {
  target: AccountId,
  events: [Recovered],
  rejects: [NotInGrace],
  middleware: [Admin],
}) {}
