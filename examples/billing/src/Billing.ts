import { InsecureDevGuards, Paykit } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
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
  guards: InsecureDevGuards,
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
