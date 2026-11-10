import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  Payments,
  PaymentsRouter,
  ProviderCapabilityMissing,
  resolveProvider,
} from "../Payments.ts";
import { Subscription } from "../Subscription/Subscription.aggregate.ts";

/** What `Portal` opens. */
export interface PortalInput {
  readonly account: string;
}

/**
 * Open the provider's customer portal, when it has one.
 *
 * The portal belongs to the provider the account already pays through, so the
 * standing picks it and only that provider's layer is provided for the call.
 */
export const portalOperation = Effect.fn("Paykit.Portal")(function* () {
  const subscription = yield* Subscription;
  const router = yield* Effect.serviceOption(PaymentsRouter);

  return Effect.fn("Paykit.Portal.open")(function* (input: PortalInput) {
    const standing = yield* subscription.state(Subscription.ref(input.account));

    const chosen = Option.match(router, {
      onNone: () => null,
      onSome: (set) => resolveProvider(set, standing.refs),
    });

    const attempt = Effect.gen(function* () {
      const payments = yield* Effect.serviceOption(Payments);

      if (Option.isNone(payments)) {
        return yield* new ProviderCapabilityMissing({
          provider: chosen?.provider.name ?? "none",
          op: "createPortal",
        });
      }

      return yield* Option.getOrThrow(payments).createPortal({ account: input.account });
    });

    return chosen === null ? yield* attempt : yield* Effect.provide(attempt, chosen.context);
  });
});
