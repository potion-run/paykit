import { InsecureDevGuards, type MoneyProvider, type PaykitWorldOptions } from "@potion.run/paykit";
import { Polar, type PolarClient } from "@potion.run/paykit-polar";
import * as Redacted from "effect/Redacted";
import { billingCatalog, messagePrice, proPrice } from "./catalog.ts";

/**
 * The values the deploy writes into the Worker's environment. The token and
 * the webhook secret are secrets; the secret is minted by the endpoint
 * `PolarBilling` created in `alchemy.run.ts`. The product and meter ids are
 * that deploy's outputs too.
 */
export interface PolarEnv {
  readonly POLAR_API_KEY: string;
  readonly POLAR_WEBHOOK_SECRET: string;
  readonly POLAR_PRODUCT_PRO: string;
  readonly POLAR_MESSAGES_METER: string;
}

/**
 * The runtime provider. Polar owns the money plane, so product ids are what
 * checkout needs; the catalog's price travels beside them so the model and the
 * vendor invoice agree.
 *
 * `client` is only for a test. A deployment omits it and Polar builds the
 * distilled client from the token, always against the sandbox in this example.
 */
export const providerOf = (
  env: PolarEnv,
  client?: PolarClient,
): MoneyProvider<"merchant_of_record"> =>
  Polar({
    accessToken: env.POLAR_API_KEY,
    server: "sandbox",
    origin: "https://app.example.com",
    tiers: {
      pro: {
        price: proPrice,
        productId: env.POLAR_PRODUCT_PRO,
        usage: { messages: messagePrice },
      },
    },
    meters: { messages: env.POLAR_MESSAGES_METER },
    webhookSecret: Redacted.make(env.POLAR_WEBHOOK_SECRET),
    ...(client === undefined ? {} : { client }),
  });

/**
 * The world the Worker and the test build around one provider. The tenant
 * bindings supply `Paykit.Subscribe` and `Paykit.Webhook`, which the money
 * routes call; this example never mounts the Api itself.
 *
 * The return type is the options type with `B` fixed to `"tenant"`, so the
 * world provides exactly the tenant bindings and a caller cannot ask this
 * process for the operator surface it never built.
 */
export const worldOptions = (
  provider: MoneyProvider,
): PaykitWorldOptions<never, never, "tenant"> => ({
  catalog: billingCatalog,
  providers: [provider],
  guards: InsecureDevGuards,
  bindings: "tenant",
});
