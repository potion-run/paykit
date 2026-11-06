import {
  allowancesOf,
  catalog,
  subscribeInputOf,
  DevGuards,
  Manual,
  ProviderCapabilityMissing,
  Paykit,
  paykitWorld,
  type MoneyProvider,
  type WebhookRequest,
} from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { billingCatalog } from "./catalog.ts";

/** The catalog, validated. A deploy that ships this file cannot sell a broken one. */
export const Catalog = Effect.runSync(catalog(billingCatalog));

/**
 * The input a `Subscribe` carries for a tier. `decide` is pure, so a command
 * carries its own allowances and price; `subscribeInputOf` is the package's
 * join, and `CatalogGuard` still refuses anything that disagrees with the
 * catalog.
 */
export const tierCommand = (tierId: string) => {
  const input = subscribeInputOf(Catalog, tierId);
  if (input === null) throw new Error(`no tier ${tierId} in the catalog`);
  return input;
};

/** What a tier grants, for an assertion or a fixture. */
export const allowancesOfTier = (tier: string) => allowancesOf(Catalog, tier)!;

/**
 * The provider the example runs by default: `Manual` sells through an invoice,
 * so the example needs no key and no account. Swapping in
 * `Polar({ ..., webhookSecret })` or `Stripe({ ..., webhookSecret })` lights up
 * the checkout and webhook routes below and nothing else moves.
 */
export const Provider: MoneyProvider = Manual();

/**
 * The billing world the Worker and the test both serve.
 *
 * `paykitWorld` builds the same graph a deployment uses: the model, the
 * catalog, the guards, the provider router and the tenant bindings. The only
 * difference is the platform — the Worker passes
 * `DomainCloudflare.layerDurableObjects()`, the test takes the default
 * `Domain.InMemory` — and `Layer.orDie` at the Worker boundary keeps a stack
 * that cannot build from serving a degraded model.
 */
export const billingLayers = <R = never>(
  provider: MoneyProvider,
  platform?: Layer.Layer<any, never, R>,
) =>
  paykitWorld({
    catalog: Catalog,
    guards: DevGuards,
    providers: [provider],
    ...(platform === undefined ? {} : { platform }),
  });

/** The layers the tests run, over an in-memory platform. */
export const BillingLayers = billingLayers(Provider);

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
          return yield* subscribe({ tier: tier });
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

/** Write one usage fact for an account, as the app does after serving a request. */
export const track = Effect.fn("Example.track")(function* (account: string, feature: string) {
  const trackUsage = yield* Paykit.TrackUsage(account);
  return yield* trackUsage({
    feature,
    amount: 1,
    dedupeKey: `${account}:${feature}:${Date.now()}`,
  });
});

/**
 * The example's own shape, for a test to run without a Cloudflare account.
 * A real deployment wraps the same layers around `layerDurableObjects`.
 */
export const BillingTestLive = BillingLayers;
