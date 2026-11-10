import { InsecureDevGuards, type MoneyProvider, type PaykitWorldOptions } from "@potion.run/paykit";
import { Stripe, type StripeClient } from "@potion.run/paykit-stripe";
import * as Redacted from "effect/Redacted";
import { billingCatalog, messagePrice, proPrice } from "./catalog.ts";

/**
 * The values the deploy writes into the Worker's environment.
 *
 * Stripe's lookup keys and meter event name are deterministic, but they are
 * still the deploy's outputs: they carry the stage, so the Worker reads them
 * from its environment rather than rebuilding a second convention. The secret
 * key and the webhook secret are secrets.
 */
export interface StripeEnv {
  readonly STRIPE_SECRET_KEY: string;
  /** The signing secret the deploy minted with the endpoint it created. */
  readonly STRIPE_WEBHOOK_SECRET: string;
  /** The base price's lookup key, from `StripeBilling("...").sold.prices.pro`. */
  readonly STRIPE_PRICE_PRO: string;
  /** The metered price's lookup key, from `sold.usage.pro.messages`. */
  readonly STRIPE_MESSAGES_PRICE: string;
  /** The meter's event name, from `sold.meters.messages`. */
  readonly STRIPE_MESSAGES_METER: string;
}

/**
 * The runtime provider. Stripe owns the money plane, so the lookup keys are
 * what checkout resolves; the catalog's price travels beside them so the model
 * and the Stripe invoice agree.
 *
 * `client` is only for a test. A deployment omits it and Stripe builds the
 * distilled client from the secret key.
 */
export const providerOf = (env: StripeEnv, client?: StripeClient): MoneyProvider<"processor"> =>
  Stripe({
    secretKey: Redacted.make(env.STRIPE_SECRET_KEY),
    origin: "https://app.example.com",
    tiers: {
      pro: {
        price: proPrice,
        lookupKey: env.STRIPE_PRICE_PRO,
        usage: {
          messages: { unitPrice: messagePrice, lookupKey: env.STRIPE_MESSAGES_PRICE },
        },
      },
    },
    meters: { messages: env.STRIPE_MESSAGES_METER },
    webhookSecret: Redacted.make(env.STRIPE_WEBHOOK_SECRET),
    ...(client === undefined ? {} : { client }),
  });

/**
 * The world the Worker and the test build around one provider. The tenant
 * bindings supply `Paykit.Subscribe` and `Paykit.Webhook`, which the money
 * routes call; this example never mounts the Api itself.
 *
 * The return type fixes `B` to `"tenant"`, so the world provides exactly the
 * tenant bindings and a caller cannot ask this process for the operator
 * surface it never built.
 */
export const worldOptions = (
  provider: MoneyProvider,
): PaykitWorldOptions<never, never, "tenant"> => ({
  catalog: billingCatalog,
  providers: [provider],
  guards: InsecureDevGuards,
  bindings: "tenant",
});
