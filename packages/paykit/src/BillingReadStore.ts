import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
  currency: Schema.optionalKey(Schema.String),
  features: Schema.Record(Schema.String, FeatureEntitlement),
});
export type BillingReadRow = typeof BillingReadRow.Type;

/**
 * The projection's port. A SQL store upserts by `account`; the memory
 * implementation backs tests and `alchemy dev`.
 */
export class BillingReadStore extends Context.Service<
  BillingReadStore,
  {
    readonly upsert: (row: BillingReadRow) => Effect.Effect<void>;
    readonly get: (account: string) => Effect.Effect<BillingReadRow | null>;
    readonly list: (options?: {
      readonly standing?: Standing;
      readonly tier?: string;
    }) => Effect.Effect<ReadonlyArray<BillingReadRow>>;
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
    get: (account) => Effect.sync(() => rows.get(account) ?? null),
    list: (options) =>
      Effect.sync(() =>
        [...rows.values()].filter(
          (row) =>
            (options?.standing === undefined || row.standing === options.standing) &&
            (options?.tier === undefined || row.tier === options.tier),
        ),
      ),
  };
});
