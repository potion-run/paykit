import * as Domain from "@alchemy.run/domain";
import { PaykitModel } from "./Paykit.model.ts";

/** What a signed-in account may do and see. */
export class BillingApi extends Domain.Api("BillingApi", {
  model: PaykitModel,
  commands: ["Subscribe", "TrackUsage", "ChangeTier", "ScheduleCancellation", "Resume"],
  views: ["Entitlements", "BillingState"],
  streams: ["AccountEvents"],
  aggregates: [],
}) {}
