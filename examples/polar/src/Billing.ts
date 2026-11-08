import {
  InsecureDevGuards,
  type MoneyProvider,
  Paykit,
  ProviderCapabilityMissing,
  type SubscribeError,
  type SubscribeResult,
  type WebhookAction,
  type WebhookApplyError,
  type WebhookError,
  type WebhookRequest,
} from "@potion.run/paykit";
import { Polar, type PolarClient } from "@potion.run/paykit-polar";
import type { Subscribe, Webhook } from "@potion.run/paykit/Billing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { billingCatalog, messagePrice, proPrice } from "./catalog.ts";

/**
 * The values the deploy writes into the Worker's environment. The token and
 * the webhook secret are secrets; the product and meter ids are the outputs of
 * the `PolarBilling` call in `alchemy.run.ts`.
 */
export interface PolarEnv {
  readonly POLAR_ACCESS_TOKEN: string;
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
    accessToken: env.POLAR_ACCESS_TOKEN,
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
 */
export const worldOptions = (provider: MoneyProvider) => ({
  catalog: billingCatalog,
  providers: [provider],
  guards: InsecureDevGuards,
  bindings: "tenant" as const,
});

/** What the two money routes answer, with the public error unions they can refuse with. */
export interface PolarMoneyRoutes {
  readonly purchase: (
    account: string,
    tier: string,
  ) => Effect.Effect<SubscribeResult, SubscribeError, Subscribe>;
  readonly deliver: (
    request: WebhookRequest,
  ) => Effect.Effect<
    { readonly action: WebhookAction | "ignored"; readonly eventId: string | null },
    ProviderCapabilityMissing | WebhookError | WebhookApplyError
  >;
}

/**
 * The two money routes, captured once at the edge. A purchase asks the
 * provider for a checkout; a delivery is verified by Polar's own decoder and
 * applied by the model.
 */
export const moneyRoutes = (
  provider: MoneyProvider,
): Effect.Effect<PolarMoneyRoutes, never, Webhook | Subscribe> =>
  Effect.gen(function* () {
    const applyWebhook = yield* Paykit.Webhook();

    return {
      purchase: (account: string, tier: string) =>
        Effect.gen(function* () {
          const subscribe = yield* Paykit.Subscribe(account);

          return yield* subscribe({ tier });
        }),

      deliver: (request: WebhookRequest) =>
        Effect.gen(function* () {
          const webhook = provider.webhook;

          if (webhook === undefined) {
            return yield* new ProviderCapabilityMissing({
              provider: provider.name,
              op: "webhook",
            });
          }

          const decoded = yield* webhook.decode(request);

          if (Option.isNone(decoded)) return { action: "ignored" as const, eventId: null };
          const action = yield* applyWebhook(decoded.value);

          return { action, eventId: decoded.value.id };
        }),
    };
  });
