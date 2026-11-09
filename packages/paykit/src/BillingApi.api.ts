import * as Domain from "@alchemy.run/domain";
import { PaykitModel } from "./Paykit.model.ts";

/**
 * What a signed-in account may do and see. Every command here is guarded by
 * the `Session` middleware and every read by the same guard on the view, so a
 * route built from this Api cannot serve another account.
 */
export class BillingApi extends Domain.Api("BillingApi", {
  model: PaykitModel,
  commands: [
    "StartTrial",
    "Subscribe",
    "TrackUsage",
    "SetBillingControls",
    "AttachEntity",
    "UpdateEntity",
    "ArchiveEntity",
    "TransferBalance",
    "Hold",
    "GrantBalance",
    "SetQuantity",
    "SetUsage",
    "SettleHold",
    "ReleaseHold",
    "ConsumeCredits",
    "CancelImmediately",
    "ChangeTier",
    "ScheduleTierChange",
    "WithdrawTierChange",
    "ScheduleCancellation",
    "CancelGroup",
    "UncancelGroup",
    "Resume",
  ],
  views: ["Entitlements", "BillingState"],
  streams: ["AccountEvents"],
  aggregates: [],
}) {}
