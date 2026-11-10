import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  Payments,
  PaymentsRouter,
  ProviderCapabilityMissing,
  resolveProvider,
} from "../Payments.ts";
import { Subscription } from "../Subscription/Subscription.aggregate.ts";

/** What `SetupPayment` opens. */
export interface SetupPaymentInput {
  readonly account: string;
  /** Stable across retries; a provider that can dedupe may use it. */
  readonly commandId?: string;
}

/**
 * Open the provider's page where a customer adds a payment method.
 *
 * The page belongs to the provider the account already pays through, so the
 * standing picks it and only that provider's built context is provided for the
 * call.
 */
export const setupPaymentOperation = Effect.fn("Paykit.SetupPayment")(function* () {
  const subscription = yield* Subscription;
  const router = yield* Effect.serviceOption(PaymentsRouter);

  return Effect.fn("Paykit.SetupPayment.open")(function* (input: SetupPaymentInput) {
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
          op: "setupPayment",
        });
      }

      return yield* Option.getOrThrow(payments).setupPayment({
        account: input.account,
        ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
      });
    });

    return chosen === null ? yield* attempt : yield* Effect.provide(attempt, chosen.context);
  });
});
