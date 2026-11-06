import type { AdminChangeTier, AdminReads } from "@potion.run/paykit/Admin";
import type { BillingAdminClient } from "@potion.run/paykit/Foldkit";
import type { Update } from "foldkit";
import type { Message } from "./Message.ts";
import type { Model } from "./Model.ts";

/**
 * What the console needs at the runtime boundary: the `BillingAdminApi`
 * client for commands and keyed reads, and `AdminReads` for the cross-account
 * list, preview, verify, holds, provider refs and catalog. The host provides
 * both as Foldkit resources.
 */
export type ConsoleResources = BillingAdminClient | AdminReads | AdminChangeTier;

export type UpdateReturn = Update.Return<Model, Message, ConsoleResources>;
