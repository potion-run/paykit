import * as Domain from "@alchemy.run/domain";
import { PaykitModel } from "./Paykit.model.ts";

/**
 * The ops console: a different middleware and a different blast radius from
 * `BillingApi`, over the same model. Every action is a command.
 */
export class BillingAdminApi extends Domain.Api("BillingAdminApi", {
  model: PaykitModel,
  commands: ["GrantCredits", "ExtendTrial", "ScheduleCancellation", "Resume", "ChangeTier"],
  views: ["Entitlements", "BillingState"],
  streams: ["AccountEvents"],
  aggregates: ["Subscription"],
}) {}
