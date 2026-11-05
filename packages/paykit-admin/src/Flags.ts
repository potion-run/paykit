import * as Schema from "effect/Schema";

/**
 * What the host seeds before Foldkit boots. `catalog` and `accounts` are
 * `Unknown` because they are snapshots: a stale schema falls back to a live
 * read in `init` instead of preventing boot.
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
  /** A wire-encoded `BillingReadPage`, for the first account list. */
  accounts: Schema.optional(Schema.Unknown),
});
export type Flags = typeof Flags.Type;
