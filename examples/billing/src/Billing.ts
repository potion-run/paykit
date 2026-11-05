import * as Domain from "@alchemy.run/domain";
import {
  allowancesOf,
  catalog,
  catalogLayer,
  tierTermsOf,
  DevGuards,
  Manual,
  MemoryBillingReadStore,
  Model,
  ProviderCapabilityMissing,
  Paykit,
  PaykitHandlers,
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
 * The input a `Subscribe` or `ChangeTier` carries for a tier. A command has to
 * carry its own allowances and price because `decide` is pure — so this is the
 * one place the example turns a tier id into a command, and `CatalogGuard`
 * refuses anything that disagrees with the catalog.
 */
export const tierCommand = (tierId: string) => {
  const terms = tierTermsOf(Catalog, tierId);
  if (terms === null) throw new Error(`no tier ${tierId} in the catalog`);
  return { tier: tierId, ...terms };
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
 * Everything the Worker and the test both need: the model with its projections,
 * the catalog the bindings read, the provider, and the two auth guards.
 *
 * The only difference between this and a deployment is the platform: the
 * Worker provides `DomainCloudflare.layerDurableObjects()`, the test provides
 * `Domain.InMemory`. Nothing else changes, which is the point of the seam —
 * and the provider is a parameter for the same reason.
 *
 * `Layer.orDie` turns a layer-construction failure into a defect: a billing
 * stack that cannot build must crash at boot, never serve a degraded model.
 */
export const billingLayers = (provider: MoneyProvider) => {
  const Providers = Paykit.paymentsRouter(provider);
  const World = Layer.mergeAll(
    // The guard needs the catalog, so it is provided to it rather than merged
    // beside it: a guard that cannot read the catalog must not run at all.
    Paykit.CatalogGuard.pipe(Layer.provideMerge(catalogLayer(Catalog))),
    provider.payments,
  ).pipe(
    Layer.provideMerge(DevGuards),
    // The store is provided to the handlers *and* merged outward, because
    // `Paykit.List` reads the projection directly rather than through a view.
    Layer.provideMerge(
      Model.layer(
        PaykitHandlers.pipe(
          Layer.provide(MemoryBillingReadStore),
          // The close-time usage policy resolves the account's provider from
          // this router; without it a postpaid close is local-only.
          Layer.provideMerge(Paykit.paymentsRouter(provider)),
        ),
      ),
    ),
    Layer.provideMerge(MemoryBillingReadStore),
    Layer.provideMerge(catalogLayer(Catalog)),
  );

  // The bindings resolve the model, the catalog and the provider router when the
  // layer is built, so they are provided rather than merged beside it.
  return Layer.mergeAll(
    World,
    Paykit.BillingInProcess.pipe(
      Layer.provide(World),
      Layer.provide(Providers),
      Layer.provide(catalogLayer(Catalog)),
    ),
    Providers,
    catalogLayer(Catalog),
  );
};

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
          const subscribe = yield* Paykit.Subscribe(account as never);
          return yield* subscribe({ tier: tier as never });
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
  const trackUsage = yield* Paykit.TrackUsage(account as never);
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
export const BillingTestLive = Layer.provide(BillingLayers, Domain.InMemory);
