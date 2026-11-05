import * as Schema from "effect/Schema";

/**
 * What the host seeds before Foldkit boots. `catalog`, `accounts` and
 * `account` are `Unknown` because they are snapshots: `decodeSnapshotFlags`
 * reads each one, and a stale schema falls back to a live read in `init`
 * instead of preventing boot.
 */
export const Flags = Schema.Struct({
  /** Page-local identity for command ids. A fresh page load gets a fresh one. */
  session: Schema.String,
  /** Display-only; every authorization decision still happens on the server. */
  actor: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
    }),
  ),
  /** A wire-encoded `Catalog`, for the first paint and tier choices. */
  catalog: Schema.optional(Schema.Unknown),
  /**
   * A wire-encoded `BillingReadPage`, for the first account list. It must
   * answer the filters in the page's URL; a host that seeds a page for another
   * query shows rows the operator did not ask for until the next refresh.
   */
  accounts: Schema.optional(Schema.Unknown),
  /**
   * A wire-encoded `AccountSnapshot` for the account the URL names. `init` uses
   * it only when the route selects that account; otherwise the live reads fill
   * the panel.
   */
  account: Schema.optional(Schema.Unknown),
});
export type Flags = typeof Flags.Type;
