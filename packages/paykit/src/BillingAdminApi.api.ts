import * as Domain from "@alchemy.run/domain";
import { PaykitModel } from "./Paykit.model.ts";

/**
 * The ops console: admin-only commands over the same model, plus the commands
 * an operator and a customer share. `Session` guards the shared ones (an
 * operator session acts for any account) and `Admin` guards the ones with a
 * wider blast radius, so a tenant session cannot reach them at all.
 *
 * `Foldkit.make(BillingAdminApi)` derives the console; do not hand-write
 * command plumbing around it.
 */
export class BillingAdminApi extends Domain.Api("BillingAdminApi", {
  model: PaykitModel,
  commands: [
    "GrantCredits",
    "ExtendTrial",
    "EnterGrace",
    "Recover",
    "Expire",
    "RecordPayment",
    "RecordPaymentFailure",
    "ScheduleCancellation",
    "Resume",
    "ChangeTier",
    "ScheduleTierChange",
    "WithdrawTierChange",
  ],
  views: ["Entitlements", "BillingState"],
  streams: ["AccountEvents"],
  aggregates: ["Subscription"],
}) {}
