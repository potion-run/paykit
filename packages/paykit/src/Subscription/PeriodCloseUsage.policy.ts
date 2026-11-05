import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  Payments,
  PaymentsRouter,
  ProviderCapabilityMissing,
  type UsageLine,
  providerFor,
} from "../Payments.ts";
import { PeriodClosed } from "./ClosePeriod.command.ts";
import { Entitlements, type EntitlementsState } from "./Entitlements.view.ts";
import { Subscription } from "./Subscription.aggregate.ts";

/**
 * The closing period's billable units, one line per price they were recorded at.
 * `included` is free, so the vendor meter is sent only the part past it — and
 * that part is already net of the grant, because `UsageRecorded.billable` is
 * the part of each event past `included` when it was recorded.
 *
 * Two lines for one feature mean the standing's unit price changed mid-period.
 * Reporting one number at the standing's price would reprice everything
 * recorded before the change, which is the bug this split exists to remove.
 */
export const billableLines = (features: EntitlementsState["features"]): ReadonlyArray<UsageLine> =>
  Object.entries(features).flatMap(([feature, value]) =>
    Object.values(value.priced ?? {})
      .filter((entry) => entry.quantity > 0)
      .map((entry) => ({ feature, unitPrice: entry.unitPrice, quantity: entry.quantity })),
  );

/**
 * The idempotency key for one period's report. The period is the command id,
 * so a redelivered close and the policy's retry are the same report to the
 * vendor rather than a second quantity.
 */
export const periodUsageCommandId = (periodStart: DateTime.Utc, periodEnd: DateTime.Utc): string =>
  `period-usage:${DateTime.toEpochMillis(periodStart)}:${DateTime.toEpochMillis(periodEnd)}`;

/**
 * At a period close, send the period's billable quantities to the provider's
 * meters. `Entitlements` is the source because its state after `PeriodClosed`
 * still holds the closing period's `used`; `UsageReset` follows in the same
 * command and is where those counters return to zero.
 *
 * The push is a policy, never part of `decide`: `decide` stays pure and the
 * provider is the invoice, not the entitlement. An account with no vendor
 * reference has no customer to meter — `Verify` reports that drift — and a
 * provider without `usage` refuses with `ProviderCapabilityMissing` rather
 * than silently billing only in local state.
 */
export class PeriodCloseUsage extends Domain.Policy("PeriodCloseUsage", {
  from: Entitlements,
  on: [PeriodClosed],
}) {}

export const PeriodCloseUsageLive = PeriodCloseUsage.toLayer(
  Effect.gen(function* () {
    const subscriptions = yield* Subscription;
    // Resolve the router while the layer is built: a policy runs in the model's
    // host context, not in a binding's call context.
    const router = Option.getOrNull(yield* Effect.serviceOption(PaymentsRouter));

    return Effect.fn("Paykit.PeriodCloseUsage.react")(function* ({ key, event, state }) {
      if (state === null) return;
      const lines = billableLines(state.features);
      if (lines.length === 0) return;

      const standing = yield* subscriptions.state(key);
      // A vendor reference is what says which customer's meter to feed. A free
      // postpaid tier that never bought anything has none, and there is no
      // vendor invoice to reconcile against.
      if (standing._tag !== "Subscribed") return;
      if (Object.keys(standing.refs).length === 0) return;

      if (router === null) return;
      const chosen = providerFor(router, standing.refs);
      if (chosen === null) return;

      const commandId = periodUsageCommandId(event.periodStart, event.periodEnd);
      const attempt = Effect.gen(function* () {
        const payments = yield* Effect.serviceOption(Payments);
        if (Option.isNone(payments)) {
          return yield* new ProviderCapabilityMissing({
            provider: chosen.name,
            op: "reportUsage",
          });
        }
        yield* payments.value.reportUsage({
          account: key.id,
          periodStart: event.periodStart,
          periodEnd: event.periodEnd,
          lines,
          commandId,
        });
      });

      // The account's own provider, not every provider in the router: a second
      // one must never receive the same usage.
      yield* Effect.provide(attempt, chosen.payments).pipe(Effect.orDie);
    });
  }),
);
