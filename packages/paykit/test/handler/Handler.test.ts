import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { allowance } from "../../src/Allowance.ts";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import { catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { handler, type HandlerOptions } from "../../src/Handler.ts";
import { PaymentsManual } from "../../src/PaymentsManual.ts";
import { tier } from "../../src/Tier.ts";
import { world } from "../../src/World.ts";

const free = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [free] }));

const provider = PaymentsManual();

/**
 * A world with both binding surfaces and a manual provider, which is what a
 * deployment serves: no key, an invoice instead of a checkout url.
 */
const testWorld = world({
  catalog: testCatalog,
  providers: [provider],
  guards: InsecureDevGuards,
  bindings: "both",
});

const account = "acct_handler";

/** One request through the handler, with the world provided the way a host does. */
const ask = (
  options: HandlerOptions,
  path: string,
  init: RequestInit = {},
): Effect.Effect<{ readonly status: number; readonly body: unknown }> =>
  Effect.gen(function* () {
    const handle = yield* handler(options);
    const headers = new Headers(init.headers);

    headers.set("x-paykit-actor", account);

    const request = HttpServerRequest.fromWeb(
      new Request(`https://billing.test${path}`, { ...init, headers }),
    );

    const response = yield* handle(request).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    );

    const web = HttpServerResponse.toWeb(response);

    const raw = yield* Effect.promise(() => web.text());
    const parsed = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(raw);

    // A refusal answers plain text and a money path answers JSON, so the body
    // is the raw string when it is not JSON.
    return { status: web.status, body: Option.isSome(parsed) ? parsed.value : raw };
  }).pipe(Effect.provide(testWorld)) as Effect.Effect<{
    readonly status: number;
    readonly body: unknown;
  }>;

const accountOf = (request: HttpServerRequest.HttpServerRequest): string | null =>
  request.headers["x-paykit-actor"] ?? null;

describe("the request handler", () => {
  it.live("sells a tier through the provider at the checkout path", () =>
    Effect.gen(function* () {
      const answer = yield* ask({ provider, accountOf, surfaces: "none" }, "/checkout?tier=free");

      // A free tier activates rather than redirecting, and the reply is the
      // Subscribe operation's own result, not a shape the handler invented.
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ activated: true });
    }),
  );

  it.live("answers a checkout with no account, and one with no tier", () =>
    Effect.gen(function* () {
      const anonymous = yield* ask(
        { provider, accountOf: () => null, surfaces: "none" },
        "/checkout?tier=free",
      );

      expect(anonymous.status).toBe(401);

      const tierless = yield* ask({ provider, accountOf, surfaces: "none" }, "/checkout");

      expect(tierless.status).toBe(400);
    }),
  );

  it.live("maps a provider without a decoder to the status httpStatus names", () =>
    Effect.gen(function* () {
      // `Manual` has no webhook to verify, which is `ProviderCapabilityMissing`:
      // 501, the same answer a route would have had to remember to map.
      const answer = yield* ask({ provider, accountOf, surfaces: "none" }, "/webhooks/manual", {
        method: "POST",
        body: "{}",
      });

      expect(answer.status).toBe(501);
      expect(answer.body).toEqual({ error: "ProviderCapabilityMissing" });
    }),
  );

  it.live("serves the plan operations at their own paths", () =>
    Effect.gen(function* () {
      const attached = yield* ask({ accountOf, surfaces: "none" }, "/plans/attach", {
        method: "POST",
        body: JSON.stringify({ planId: "free", idempotencyKey: "h-attach" }),
      });

      expect(attached.status).toBe(200);
      expect(attached.body).toMatchObject({ outcome: "activated", planId: "free" });

      const preview = yield* ask({ accountOf, surfaces: "none" }, "/plans/preview-attach", {
        method: "POST",
        body: JSON.stringify({ planId: "free" }),
      });

      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({ outcome: "activated", planId: "free" });
    }),
  );

  it.live("refuses a plan request with no account or a bad body", () =>
    Effect.gen(function* () {
      const anonymous = yield* ask({ accountOf: () => null, surfaces: "none" }, "/plans/attach", {
        method: "POST",
        body: JSON.stringify({ planId: "free", idempotencyKey: "h-anon" }),
      });

      expect(anonymous.status).toBe(401);

      const invalid = yield* ask({ accountOf, surfaces: "none" }, "/plans/attach", {
        method: "POST",
        body: JSON.stringify({ planId: "free" }),
      });

      expect(invalid.status).toBe(400);
    }),
  );
  it.live("mounts the two Api surfaces, and only the ones it was asked for", () =>
    Effect.gen(function* () {
      const tenantOnly = yield* ask({ accountOf, surfaces: "tenant" }, "/admin/absent");
      expect(tenantOnly.status).toBe(404);

      const none = yield* ask({ accountOf, surfaces: "none" }, "/api");
      expect(none.status).toBe(404);
    }),
  );

  it.live("tries the deployment's own routes before the built-ins", () =>
    Effect.gen(function* () {
      const answer = yield* ask(
        {
          provider,
          accountOf,
          surfaces: "both",
          routes: [
            {
              path: "/api",
              handle: () =>
                Effect.succeed(HttpServerResponse.jsonUnsafe({ mine: true }, { status: 200 })),
            },
          ],
        },
        "/api",
      );

      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ mine: true });
    }),
  );

  it.live("moves a mount point without re-deriving the table", () =>
    Effect.gen(function* () {
      const answer = yield* ask(
        { provider, accountOf, surfaces: "none", mount: { checkout: "/billing/pay" } },
        "/billing/pay?tier=free",
      );

      expect(answer.status).toBe(200);

      // The default path is gone, because the mount moved rather than added.
      const moved = yield* ask(
        { provider, accountOf, surfaces: "none", mount: { checkout: "/billing/pay" } },
        "/checkout?tier=free",
      );

      expect(moved.status).toBe(404);
    }),
  );
});
