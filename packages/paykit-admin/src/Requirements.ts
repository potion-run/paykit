import type { AdminChangeTier, AdminReads, AdminRefund } from "@potion.run/paykit/Admin";
import type { BillingAdminClient } from "@potion.run/paykit/Foldkit";
import type { Update } from "foldkit";
import type { Message } from "./Message.ts";
import type { Model } from "./Model.ts";

/**
 * What the console needs at the runtime boundary: the `BillingAdminApi`
 * client for commands and keyed reads, `AdminReads` for the cross-account list,
 * preview, verify, holds, provider refs and catalog, `AdminChangeTier` for the
 * quote/apply flow, and `AdminRefund` for the one write that reaches the
 * provider. The host provides all four as Foldkit resources.
 */
export type ConsoleResources = BillingAdminClient | AdminReads | AdminChangeTier | AdminRefund;

export type UpdateReturn = Update.Return<Model, Message, ConsoleResources>;
