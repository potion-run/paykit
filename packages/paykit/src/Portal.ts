import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Payments, ProviderCapabilityMissing } from "./Payments.ts";

/** What `Portal` opens. */
export interface PortalInput {
  readonly account: string;
}

/** Open the provider's customer portal, when it has one. */
export const Portal = Effect.fn("Paykit.Portal")(function* () {
  const payments = yield* Effect.serviceOption(Payments);
  return Effect.fn("Paykit.Portal.open")(function* (input: PortalInput) {
    if (Option.isNone(payments)) {
      return yield* new ProviderCapabilityMissing({ provider: "none", op: "createPortal" });
    }
    return yield* Option.getOrThrow(payments).createPortal({ account: input.account });
  });
});
