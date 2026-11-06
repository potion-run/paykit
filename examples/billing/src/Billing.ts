import {
  DevGuards,
  type MoneyProvider,
  Paykit,
  ProviderCapabilityMissing,
  type WebhookRequest,
} from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { billing } from "./billing.config.ts";

/** The catalog the deploy declares, for a test or a page that reads it. */
export const Catalog = billing.catalog;

/**
 * The provider the example runs by default: `Manual` sells through an invoice,
 * so the example needs no key and no account. Swapping in
 * `Polar({ ..., webhookSecret })` or `Stripe({ ..., webhookSecret })` lights up
 * the checkout and webhook routes below and nothing else moves.
 */
export const Provider = billing.providers[0]!;

/**
 * The billing world the Worker and the test both serve.
 *
 * `Paykit.world` builds the same graph a deployment uses: the model, the
 * catalog, the guards, the provider router and the tenant bindings. The only
 * difference is the platform — the Worker passes a Durable Object or SQL host,
 * the test takes the default `Domain.InMemory`. `Effect.orDie` at the Worker
 * boundary keeps a stack that cannot build from serving a degraded model.
 */
export const BillingTestLive = Paykit.world({
  ...billing,
  guards: DevGuards,
});

/**
 * The two money routes as a binding, the way every other paykit primitive is
 * built: the services resolve once, at the edge, and each request is a call
 * into the captured bindings. Pure in the provider, so a test can hand it one
 * that needs no key.
 */
export const moneyRoutes = (provider: MoneyProvider) =>
  Effect.gen(function* () {
    const applyWebhook = yield* Paykit.Webhook();

    return {
      /**
       * Ask the provider for a path to pay. A priced tier returns the
       * provider's checkout URL (or an invoice id, when that is all it has); a
       * free tier activates and returns `{ activated: true }`.
       */
      purchase: (account: string, tier: string) =>
        Effect.gen(function* () {
          const subscribe = yield* Paykit.Subscribe(account);
          return yield* subscribe({ tier });
        }),

      /**
       * Verify one provider delivery and apply it. `none` from the decoder is a
       * provider event paykit does not model: the route answers 202 and records
       * nothing, which is what stops a provider retrying it forever.
       */
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

/**
 * Write one usage fact for an account, as the app does after serving a request.
 *
 * The `dedupeKey` is the request's own id, supplied by the caller: a key built
 * from the clock would make a retried delivery a second charge, which is the
 * one thing a dedupe key exists to prevent.
 */
export const track = Effect.fn("Example.track")(function* (
  account: string,
  usage: {
    readonly feature: string;
    readonly dedupeKey: string;
    readonly amount?: number;
    readonly dimension?: string;
  },
) {
  const trackUsage = yield* Paykit.TrackUsage(account);
  return yield* trackUsage({
    feature: usage.feature,
    amount: usage.amount ?? 1,
    dedupeKey: usage.dedupeKey,
    ...(usage.dimension === undefined ? {} : { dimension: usage.dimension }),
  });
});
