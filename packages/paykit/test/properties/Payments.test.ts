import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Payments, type PaymentCapability, type PaymentsService } from "../../src/Payments.ts";
import { PaymentsStripe, type StripeBindings } from "../../src/PaymentsStripe.ts";
import { assertProperty } from "../support/Property.ts";

const price = { amount: 1900, currency: "usd", interval: "month" as const };

/** Which optional bindings a Stripe adapter under test was given. */
const Binds = Schema.Struct({
  invoice: Schema.Boolean,
  charge: Schema.Boolean,
  refund: Schema.Boolean,
  usage: Schema.Boolean,
});

type Binds = typeof Binds.Type;

const providerOf = (binds: Binds) => {
  const optional: Partial<StripeBindings> = {
    ...(binds.invoice ? { createInvoice: () => Effect.succeed({ invoiceId: "in_test" }) } : {}),
    ...(binds.charge ? { charge: () => Effect.succeed({ chargeId: "pi_test" }) } : {}),
    ...(binds.refund ? { createRefund: () => Effect.succeed({ refundId: "re_test" }) } : {}),
    ...(binds.usage ? { reportUsage: () => Effect.succeed({}) } : {}),
  };

  return PaymentsStripe({
    bindings: {
      createCheckoutSession: () => Effect.succeed({ url: "https://checkout.test" }),
      createCustomerSession: () => Effect.succeed({ url: "https://portal.test" }),
      ...optional,
    },
    tiers: { pro: { price, priceId: "price_1" } },
  });
};

/** The capability each optional binding stands for. */
const optionalOf = (binds: Binds) =>
  ({
    invoice: binds.invoice,
    charge: binds.charge,
    refund: binds.refund,
    usage: binds.usage,
  }) satisfies Readonly<Record<"invoice" | "charge" | "refund" | "usage", boolean>>;

describe("the Payments port", () => {
  /**
   * A provider declares what it implements and nothing else. A capability is a
   * promise the policy relies on: the auto top-up charges when `charge` is
   * declared and invoices when it is not, so a declaration that outran a
   * binding would make the policy choose a path the provider cannot take.
   */
  it.effect("declares a capability exactly when its binding is there", () =>
    assertProperty(
      Arbitrary.schema(Binds),
      (binds) => {
        const declared = providerOf(binds).capabilities;
        // Every provider can sell and open a portal; the rest are optional.
        const required: ReadonlyArray<PaymentCapability> = ["checkout", "portal"];

        if (required.some((capability) => !declared.has(capability))) return false;

        return Object.entries(optionalOf(binds)).every(
          ([capability, bound]) => declared.has(capability as PaymentCapability) === bound,
        );
      },
      { runs: 50, size: 10 },
    ),
  );

  /**
   * Asking for an operation a provider does not implement is a typed refusal,
   * never a defect: a caller can match `ProviderCapabilityMissing` and record
   * why nothing happened, and the auto top-up falls back rather than dying.
   */
  it.effect("answers an undeclared operation with a tag, not a crash", () =>
    assertProperty(
      Arbitrary.schema(Binds),
      (binds) => {
        const provider = providerOf(binds);

        const ask = (
          capability: PaymentCapability,
          call: (payments: PaymentsService) => Effect.Effect<unknown, unknown>,
        ): Effect.Effect<boolean, never, never> =>
          provider.capabilities.has(capability)
            ? Effect.succeed(true)
            : Effect.gen(function* () {
                const payments = yield* Payments;
                const exit = yield* Effect.exit(call(payments));

                // A refusal is the declared tag, never a defect.
                return (
                  Exit.isFailure(exit) && String(exit.cause).includes("ProviderCapabilityMissing")
                );
              }).pipe(Effect.provide(provider.payments));

        return Effect.all(
          [
            ask("invoice", (payments) =>
              payments.createInvoice({ account: "acct_1", amount: 100, currency: "usd" }),
            ),
            ask("charge", (payments) =>
              payments.charge({ account: "acct_1", amount: 100, currency: "usd" }),
            ),
            ask("refund", (payments) => payments.refund({ chargeId: "ch_1", amount: 100 })),
          ],
          { concurrency: 1 },
        ).pipe(Effect.map((answers) => answers.every((answer) => answer)));
      },
      { runs: 40, size: 10 },
    ),
  );
});
