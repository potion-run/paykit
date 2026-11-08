import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { Subscribe, Webhook } from "./Billing/index.ts";
import { BillingAdminApi } from "./BillingAdminApi.api.ts";
import { BillingApi } from "./BillingApi.api.ts";
import { httpStatus } from "./HttpStatus.ts";
import { ProviderCapabilityMissing, type MoneyProvider } from "./Payments.ts";
import type { WebhookRequest } from "./Webhooks.ts";

/**
 * The two money paths as a binding, the way every other paykit primitive is
 * built: the services resolve once, at the edge, and each request is a call
 * into the captured bindings. Pure in the provider, so a test can hand it one
 * that needs no key.
 *
 * `Paykit.handler` uses it; a deployment that mounts its own paths gets the same
 * pair rather than a copy of it, which is what happened in two examples before
 * ADR 0029.
 *
 * ### Selling a tier and applying a delivery
 * **Example:** The checkout and webhook pair for one provider
 * ```typescript
 * const routes = yield* Paykit.moneyRoutes(Provider);
 *
 * const purchase = yield* routes.purchase(account, "pro");
 * const applied = yield* routes.deliver({ headers: request.headers, body });
 * ```
 *
 * @primitive
 */
export const moneyRoutes = (provider: MoneyProvider) =>
  Effect.gen(function* () {
    const applyWebhook = yield* Webhook();

    const purchase = Effect.fn("Paykit.moneyRoutes.purchase")(function* (
      account: string,
      tier: string,
    ) {
      const subscribe = yield* Subscribe(account);

      return yield* subscribe({ tier });
    });

    const deliver = Effect.fn("Paykit.moneyRoutes.deliver")(function* (request: WebhookRequest) {
      const webhook = provider.webhook;

      // A provider with no decoder has no delivery to verify, which is a
      // deployment error rather than a payload paykit ignores.
      if (webhook === undefined) {
        return yield* new ProviderCapabilityMissing({
          provider: provider.name,
          op: "webhook",
        });
      }

      const decoded = yield* webhook.decode(request);

      // A `none` is a provider event paykit does not model: acknowledged, and
      // nothing recorded, so the provider stops retrying it.
      if (Option.isNone(decoded)) return { action: "ignored" as const, eventId: null };

      const action = yield* applyWebhook(decoded.value);

      return { action, eventId: decoded.value.id };
    });

    return { purchase, deliver };
  });

/** What `moneyRoutes` resolves: the purchase verb and the delivery verb. */
export type MoneyRoutes = Effect.Success<ReturnType<typeof moneyRoutes>>;

/** One path a deployment answers itself, matched exactly and tried first. */
export interface HandlerRoute {
  readonly path: string;
  readonly handle: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
}

/** Where each built-in surface answers. Override with `mount`. */
export interface HandlerMount {
  /** The tenant Api. Defaults to `/api`. */
  readonly tenant?: string;
  /** The operator Api. Defaults to `/admin`. */
  readonly admin?: string;
  /** The purchase path. Defaults to `/checkout`. */
  readonly checkout?: string;
  /** The prefix a provider delivery is posted under. Defaults to `/webhooks`. */
  readonly webhooks?: string;
}

/** Which Api surfaces a handler mounts. Defaults to `"both"`. */
export type HandlerSurfaces = "tenant" | "admin" | "both" | "none";

export interface HandlerOptions {
  /**
   * The provider the money paths sell through and verify deliveries from.
   * Omitted, the handler mounts no `/checkout` and no `/webhooks`.
   */
  readonly provider?: MoneyProvider;
  /**
   * The account a `/checkout` request acts for, read from the deployment's own
   * session. Identity is the identity provider's file, so the handler will not
   * guess it: with no `accountOf`, a purchase answers 401.
   */
  readonly accountOf?: (request: HttpServerRequest.HttpServerRequest) => string | null;
  /** Which Api surfaces to mount. Defaults to `"both"`. */
  readonly surfaces?: HandlerSurfaces;
  /** Where the built-in surfaces answer. */
  readonly mount?: HandlerMount;
  /**
   * The deployment's own paths, matched exactly and before the built-ins. This
   * is where an MCP server, a page, or a console's forwarding route goes.
   */
  readonly routes?: ReadonlyArray<HandlerRoute>;
}

const text = (body: string, status: number) => HttpServerResponse.text(body, { status });

/**
 * The five paths every paykit deployment serves, as one request handler.
 *
 * The handler builds no world: it requires `BillingApi` and `BillingAdminApi`
 * and never constructs them, so the process that provides the world is the one
 * that answers, and a route cannot serve a second copy of the model. A host
 * whose bindings exist only inside a request — a D1 binding, on Cloudflare —
 * keeps its `Effect.provide` at the call site.
 *
 * A refusal answers `Paykit.httpStatus`, so the five examples cannot disagree
 * about what a `TierNotInCatalog` or a spent `RefundExceedsCharged` returns. A
 * delivery answers 202 whether or not it recorded anything, because a provider
 * should not retry an event paykit does not model.
 *
 * ### A Worker's five paths
 * **Example:** The tenant Api, the console, checkout and webhooks
 * ```typescript
 * const serve = (database: Cloudflare.D1.QueryDatabaseClient) => ({
 *   fetch: Effect.gen(function* () {
 *     const request = yield* HttpServerRequest.HttpServerRequest;
 *     const handle = yield* Paykit.handler({
 *       provider: Provider,
 *       accountOf: (incoming) => incoming.headers[ACTOR_HEADER] ?? null,
 *     });
 *
 *     return yield* handle(request).pipe(
 *       Effect.provide(Layer.mergeAll(billingOnSql(yield* database.raw).world, Provider.payments)),
 *       Effect.orDie,
 *     );
 *   }),
 * });
 * ```
 *
 * @primitive
 */
export const handler = (options: HandlerOptions = {}) =>
  Effect.gen(function* () {
    const surfaces = options.surfaces ?? "both";
    const tenant = surfaces === "tenant" || surfaces === "both" ? yield* BillingApi : null;
    const admin = surfaces === "admin" || surfaces === "both" ? yield* BillingAdminApi : null;
    const money = options.provider === undefined ? null : yield* moneyRoutes(options.provider);
    const accountOf = options.accountOf ?? (() => null);

    const mount = {
      tenant: options.mount?.tenant ?? "/api",
      admin: options.mount?.admin ?? "/admin",
      checkout: options.mount?.checkout ?? "/checkout",
      webhooks: options.mount?.webhooks ?? "/webhooks",
    };

    return Effect.fn("Paykit.handler")(function* (request: HttpServerRequest.HttpServerRequest) {
      const url = new URL(request.url, "http://localhost");
      const path = url.pathname;

      // The deployment's own paths win, so nothing here is forced on a
      // deployment that wants a different answer for one of them.
      for (const route of options.routes ?? []) {
        if (route.path === path) return yield* route.handle(request);
      }

      if (tenant !== null && path.startsWith(mount.tenant)) return yield* tenant.fetch;

      if (admin !== null && path.startsWith(mount.admin)) return yield* admin.fetch;

      if (money !== null && path === mount.checkout) {
        const account = accountOf(request);

        if (account === null) return text("an account is required", 401);

        const tier = url.searchParams.get("tier");

        if (tier === null) return text("?tier= is required", 400);

        const purchase = yield* Effect.result(money.purchase(account, tier));

        return Result.isFailure(purchase)
          ? HttpServerResponse.jsonUnsafe(
              { error: purchase.failure._tag },
              { status: httpStatus(purchase.failure) },
            )
          : HttpServerResponse.jsonUnsafe(purchase.success, { status: 200 });
      }

      if (money !== null && path.startsWith(mount.webhooks)) {
        const body = yield* request.text;

        const applied = yield* Effect.result(money.deliver({ headers: request.headers, body }));

        // A failure still answers a status, not a 2xx: a delivery paykit could
        // not apply is one the provider retries. A `none` from the decoder is
        // the 202 that records nothing.
        return Result.isFailure(applied)
          ? HttpServerResponse.jsonUnsafe(
              { error: applied.failure._tag },
              { status: httpStatus(applied.failure) },
            )
          : HttpServerResponse.jsonUnsafe(applied.success, { status: 202 });
      }

      return text("Not Found", 404);
    });
  });
