import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { BillingReadStore, type BillingReadRow } from "../BillingReadStore.ts";
import { Entitlements } from "./Entitlements.view.ts";
import { Subscription } from "./Subscription.aggregate.ts";
import { standingOf } from "./Subscription.state.ts";

/**
 * Cross-account reads: dashboards, lists and the edge read path. A view folds
 * one key, so this is the only place a list can come from.
 */
export class BillingRead extends Domain.Projection("BillingRead", {
  from: [Entitlements],
  key: Subscription,
  on: Subscription.definition.events,
}) {}

export const BillingReadLive = BillingRead.toLayer(
  Effect.gen(function* () {
    const store = yield* BillingReadStore;
    return Effect.fn("Paykit.BillingRead.project")(function* (batch) {
      for (const input of batch) {
        if (input.state === null) continue;
        const row: BillingReadRow = {
          account: input.key.id,
          tier: input.state.tier,
          status: input.state.status,
          standing: standingOf(input.state.status),
          periodStart: input.state.periodStart,
          periodEnd: input.state.periodEnd,
          cancelAtPeriodEnd: input.state.cancelAtPeriodEnd,
          credits: input.state.credits,
          dunningAttempts: input.state.dunningAttempts,
          ...(input.state.proration === undefined ? {} : { proration: input.state.proration }),
          ...(input.state.prorationInvoice === undefined
            ? {}
            : { prorationInvoice: input.state.prorationInvoice }),
          ...(input.state.currency === undefined ? {} : { currency: input.state.currency }),
          features: input.state.features,
        };
        yield* store.upsert(row);
      }
    });
  }),
);
