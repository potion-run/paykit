import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Proration } from "./Proration.ts";
import { FeatureEntitlement } from "./Subscription/Entitlements.view.ts";
import { Standing, SubscriptionStatus } from "./Subscription/Subscription.state.ts";

/** One row a dashboard or the edge read path can query without a view. */
export const BillingReadRow = Schema.Struct({
  account: Schema.String,
  tier: Schema.String,
  status: SubscriptionStatus,
  standing: Standing,
  periodStart: Schema.DateTimeUtc,
  periodEnd: Schema.DateTimeUtc,
  cancelAtPeriodEnd: Schema.Boolean,
  credits: Schema.Int,
  /** Payment failures recorded for this standing, including a policy retry. */
  dunningAttempts: Schema.Int,
  /** The money the last tier change moved, and the invoice it was billed on. */
  proration: Schema.optionalKey(Proration),
  prorationInvoice: Schema.optionalKey(Schema.String),
  currency: Schema.optionalKey(Schema.String),
  features: Schema.Record(Schema.String, FeatureEntitlement),
});
export type BillingReadRow = typeof BillingReadRow.Type;

/** The order a page walks accounts in. `asc` is the default. */
export const AccountOrder = Schema.Literals(["asc", "desc"]);
export type AccountOrder = typeof AccountOrder.Type;

/** The default page size, and the most one page may carry. */
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

/**
 * What a cross-account read asks for. `after` is the cursor a previous page
 * returned in `next`, not an offset: an account created or deleted between
 * pages shifts no row, so a page never repeats or skips an account.
 */
export const BillingReadQuery = Schema.Struct({
  standing: Schema.optionalKey(Standing),
  tier: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(SubscriptionStatus),
  order: Schema.optionalKey(AccountOrder),
  /** How many rows to return. Defaults to 50, capped at 200. */
  take: Schema.optionalKey(Schema.Int),
  /** The cursor from a previous page's `next`. */
  after: Schema.optionalKey(Schema.String),
});
export type BillingReadQuery = typeof BillingReadQuery.Type;

/** One page of accounts, and the cursor for the next one. */
export const BillingReadPage = Schema.Struct({
  rows: Schema.Array(BillingReadRow),
  /** `null` when this is the last page. */
  next: Schema.NullOr(Schema.String),
  /**
   * When the store answered this page. A list is a point-in-time read, not a
   * subscription: `List` stamps this so a console can say how old the rows
   * are instead of presenting them as live. Absent from a page built by hand
   * (`queryRows`, a fixture), which is why the console treats "no stamp" as
   * "provenance unknown" rather than as "now".
   */
  asOf: Schema.optionalKey(Schema.DateTimeUtc),
});
export type BillingReadPage = typeof BillingReadPage.Type;

const pageSizeOf = (query: BillingReadQuery): number =>
  Math.min(MAX_PAGE, Math.max(1, query.take ?? DEFAULT_PAGE));

/**
 * The one order a page and its cursor share. `localeCompare` is not it: its
 * collation is locale-dependent and disagrees with the `<`/`>` comparison the
 * `after` filter and SQL's `ORDER BY account` use, so an account that sorted
 * before the cursor could be skipped by every later page.
 */
const compareAccounts = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** The rows a query selects, in the order it walks them. */
export const queryRows = (
  rows: ReadonlyArray<BillingReadRow>,
  query: BillingReadQuery = {},
): BillingReadPage => {
  const order = query.order ?? "asc";
  const selected = rows
    .filter(
      (row) =>
        (query.standing === undefined || row.standing === query.standing) &&
        (query.tier === undefined || row.tier === query.tier) &&
        (query.status === undefined || row.status === query.status),
    )
    .sort((left, right) =>
      order === "asc"
        ? compareAccounts(left.account, right.account)
        : compareAccounts(right.account, left.account),
    );
  const after =
    query.after === undefined
      ? selected
      : selected.filter((row) =>
          order === "asc" ? row.account > query.after! : row.account < query.after!,
        );
  const take = pageSizeOf(query);
  const page = after.slice(0, take);
  const last = page[page.length - 1];
  return {
    rows: page,
    next: after.length > take && last !== undefined ? last.account : null,
  };
};

/**
 * The projection's port. A SQL store upserts by `account` and answers a page
 * from one indexed query; the memory implementation backs tests and
 * `alchemy dev`. Rows are rebuildable from the event log at any moment, so a
 * store never becomes a second source of truth.
 */
export class BillingReadStore extends Context.Service<
  BillingReadStore,
  {
    readonly upsert: (row: BillingReadRow) => Effect.Effect<void>;
    readonly get: (account: string) => Effect.Effect<BillingReadRow | null>;
    /** One page of accounts. The only cross-account read the model offers. */
    readonly list: (query?: BillingReadQuery) => Effect.Effect<BillingReadPage>;
  }
>()("paykit/BillingReadStore") {}

/** A memory `BillingReadStore`, rebuildable from the event log at any time. */
export const MemoryBillingReadStore = Layer.sync(BillingReadStore, () => {
  const rows = new Map<string, BillingReadRow>();
  return {
    upsert: (row) =>
      Effect.sync(() => {
        rows.set(row.account, row);
      }),
    get: (account) =>
      Effect.sync(() => Option.getOrNull(Option.fromUndefinedOr(rows.get(account)))),
    list: (query) => Effect.sync(() => queryRows([...rows.values()], query)),
  };
});
