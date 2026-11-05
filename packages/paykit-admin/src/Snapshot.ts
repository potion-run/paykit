import { BillingReadPage } from "@potion.run/paykit/BillingReadStore";
import { Catalog } from "@potion.run/paykit/Catalog";
import { BillingStateView } from "@potion.run/paykit/Subscription/BillingState.view";
import { EntitlementsState } from "@potion.run/paykit/Subscription/Entitlements.view";
import { AccountId } from "@potion.run/paykit/Subscription/Subscription.state";
import * as Schema from "effect/Schema";
import type { Flags } from "./Flags.ts";

/**
 * One account's first-paint state, as the host read it. The two views are the
 * same schemas the live reads return, so a snapshot is the first frame of the
 * watch rather than a second shape to keep in step.
 */
export const AccountSnapshot = Schema.Struct({
  /** Which account this is the snapshot of. A route naming another account ignores it. */
  account: AccountId,
  billing: Schema.optionalKey(BillingStateView),
  entitlements: Schema.optionalKey(EntitlementsState),
  /**
   * The last event sequence the snapshot includes. The feed resumes after it,
   * so a seeded account does not replay the history it already shows.
   */
  cursor: Schema.optionalKey(Schema.Int),
});
export type AccountSnapshot = typeof AccountSnapshot.Type;

/** The snapshots a host may seed, decoded. */
export const SnapshotFlags = Schema.Struct({
  catalog: Schema.Option(Catalog),
  accounts: Schema.Option(BillingReadPage),
  account: Schema.Option(AccountSnapshot),
});
export type SnapshotFlags = typeof SnapshotFlags.Type;

/**
 * Decode what the host seeded. Each snapshot is `Unknown` in `Flags` on
 * purpose: a snapshot the schema no longer matches is dropped, and `init`
 * asks the live read for the same thing instead. A stale deployment skew
 * costs a round trip, never boot.
 *
 * @primitive
 */
export const decodeSnapshotFlags = (flags: Flags): SnapshotFlags => ({
  catalog: Schema.decodeUnknownOption(Catalog)(flags.catalog),
  accounts: Schema.decodeUnknownOption(BillingReadPage)(flags.accounts),
  account: Schema.decodeUnknownOption(AccountSnapshot)(flags.account),
});
