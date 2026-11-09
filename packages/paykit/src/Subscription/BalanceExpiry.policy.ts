import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { ExpireGrant } from "./ExpireGrant.command.ts";
import { BalanceGranted } from "./GrantBalance.command.ts";
import { Subscription } from "./Subscription.aggregate.ts";

/**
 * Whenever an expiring grant is created, schedule the deadline that removes it.
 * The deadline is keyed by the grant id, so a redelivered `BalanceGranted`
 * schedules one expiry rather than two. A lifetime grant has no deadline and
 * schedules nothing.
 */
export class BalanceExpiry extends Domain.Policy("BalanceExpiry", {
  from: Subscription,
  on: [BalanceGranted],
}) {}

export const BalanceExpiryLive = BalanceExpiry.toLayer(
  Effect.gen(function* () {
    const subscriptions = yield* Subscription;

    return Effect.fn("Paykit.BalanceExpiry.react")(function* ({ key, event }) {
      if (event.expiresAt === undefined) return;

      yield* subscriptions
        .schedule(key, new ExpireGrant({ feature: event.feature, grantId: event.grantId }), {
          at: event.expiresAt,
          commandId: `grant-expired:${event.grantId}`,
        })
        .pipe(Effect.catchTag("AlreadyExecuted", () => Effect.void));
    });
  }),
);
