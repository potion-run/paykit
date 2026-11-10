import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as DistilledPolar from "@distilled.cloud/polar";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  POLAR_WEBHOOK_EVENTS,
  WebhookEndpoint,
  WebhookEndpointProvider,
  polarWebhookEndpoint,
  webhookEndpointNameOf,
} from "../src/WebhookEndpoint.ts";

/**
 * `WebhookEndpoint` against a stand-in for Polar's webhook endpoints API.
 *
 * This is a contract test, not the live proof: no Polar account is touched,
 * and only the HTTP transport is a fake, so the request bodies still go through
 * the real protocol and schemas. It covers the lifecycle the Reconciler
 * doctrine asks of one flow — create, adopt, update in place, no-op on an
 * unchanged deploy, and delete on destroy — plus the one piece of state the
 * vendor will not hand back twice: the signing secret.
 */

const bodyOf = (request: HttpClientRequest.HttpClientRequest): unknown => {
  const body = request.body;

  if (body._tag !== "Uint8Array") return undefined;

  return JSON.parse(new TextDecoder().decode(body.body));
};

const fakePolar = () => {
  const endpoints = new Map<string, DistilledPolar.WebhookEndpoint>();
  const calls: Array<string> = [];
  let created = 0;
  let hidesSecret = false;

  const json = (
    request: HttpClientRequest.HttpClientRequest,
    status: number,
    body: unknown,
  ): HttpClientResponse.HttpClientResponse =>
    HttpClientResponse.fromWeb(request, Response.json(body, { status }));

  // Polar's schema requires a string, so an omitted secret reads back as an
  // empty one. A provider that used the observed value instead of state would
  // store the empty string and silently stop verifying deliveries.
  const observed = (endpoint: DistilledPolar.WebhookEndpoint): DistilledPolar.WebhookEndpoint =>
    hidesSecret ? { ...endpoint, secret: "" } : endpoint;

  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.suspend(() => {
        const url = new URL(request.url);
        calls.push(`${request.method} ${url.pathname}`);
        const itemId = url.pathname.match(/^\/v1\/webhooks\/endpoints\/([^/]+)$/)?.[1];

        const isCollection =
          url.pathname === "/v1/webhooks/endpoints/" || url.pathname === "/v1/webhooks/endpoints";

        if (isCollection && request.method === "POST") {
          const body = bodyOf(request) as {
            readonly url: string;
            readonly name?: string | null;
            readonly format: string;
            readonly events: ReadonlyArray<string>;
          };

          const id = `wh_${++created}`;

          const endpoint: DistilledPolar.WebhookEndpoint = {
            created_at: new Date(Date.UTC(2030, 0, 1, 0, 0, created)).toISOString(),
            modified_at: null,
            id,
            url: body.url,
            name: body.name ?? null,
            api_version: "2026-04",
            format: body.format as DistilledPolar.WebhookFormat,
            secret: `whsec_${id}`,
            organization_id: "org_fake",
            events: body.events as Array<DistilledPolar.WebhookEventType>,
            enabled: true,
            uses_standard_webhook_signature: true,
          };

          endpoints.set(id, endpoint);

          return Effect.succeed(json(request, 201, endpoint));
        }

        if (isCollection && request.method === "GET") {
          const matches = [...endpoints.values()].map(observed);

          return Effect.succeed(
            json(request, 200, {
              items: matches,
              pagination: { total_count: matches.length, max_page: 1 },
            }),
          );
        }

        if (itemId !== undefined && request.method === "GET") {
          const endpoint = endpoints.get(itemId);

          return Effect.succeed(
            endpoint === undefined
              ? json(request, 404, { detail: "Not found" })
              : json(request, 200, observed(endpoint)),
          );
        }

        if (itemId !== undefined && request.method === "PATCH") {
          const current = endpoints.get(itemId);

          if (current === undefined) {
            return Effect.succeed(json(request, 404, { detail: "Not found" }));
          }

          const body = bodyOf(request) as {
            readonly url?: string | null;
            readonly name?: string | null;
            readonly format?: string | null;
            readonly events?: ReadonlyArray<string> | null;
            readonly enabled?: boolean | null;
          };

          const updated: DistilledPolar.WebhookEndpoint = {
            ...current,
            ...(body.url == null ? {} : { url: body.url }),
            ...(body.name == null ? {} : { name: body.name }),
            ...(body.format == null ? {} : { format: body.format as DistilledPolar.WebhookFormat }),
            ...(body.events == null
              ? {}
              : { events: [...body.events] as Array<DistilledPolar.WebhookEventType> }),
            ...(body.enabled == null ? {} : { enabled: body.enabled }),
          };

          endpoints.set(updated.id, updated);

          return Effect.succeed(json(request, 200, observed(updated)));
        }

        if (itemId !== undefined && request.method === "DELETE") {
          endpoints.delete(itemId);

          return Effect.succeed(json(request, 200, {}));
        }

        return Effect.die(`the fake Polar does not implement ${request.method} ${url.pathname}`);
      }),
    ),
  );

  return {
    layer,
    endpoints,
    calls,
    reset: () => {
      endpoints.clear();
      calls.length = 0;
      created = 0;
      hidesSecret = false;
    },
    hideSecret: () => {
      hidesSecret = true;
    },
  };
};

const polar = fakePolar();

const { test } = Test.make({
  providers: WebhookEndpointProvider().pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        DistilledPolar.PolarProtocol,
        polar.layer,
        Layer.succeed(
          DistilledPolar.Credentials,
          Effect.succeed({
            apiKey: Redacted.make("polar_fake"),
            apiBaseUrl: "https://sandbox.example",
          }),
        ),
      ),
    ),
  ),
});

const url = "https://app.example.com/webhooks/polar";
const moved = "https://app.example.com/hooks/polar";

test.provider("creates the endpoint at the derived identity", (stack) =>
  Effect.gen(function* () {
    polar.reset();

    const endpoint = yield* stack.deploy(polarWebhookEndpoint("Webhook", { url }));
    const vendor = polar.endpoints.get(endpoint.id);

    expect(vendor?.name).toBe(webhookEndpointNameOf(stack.name, stack.stage));
    expect(vendor?.url).toBe(url);
    expect(vendor?.format).toBe("raw");
    expect(vendor?.events).toEqual([...POLAR_WEBHOOK_EVENTS]);
    expect(vendor?.enabled).toBe(true);
    expect(Redacted.value(endpoint.secret!)).toBe(`whsec_${endpoint.id}`);
  }),
);

test.provider("a second deploy of the same endpoint is a no-op", (stack) =>
  Effect.gen(function* () {
    polar.reset();
    const first = yield* stack.deploy(polarWebhookEndpoint("Webhook", { url }));
    const creates = polar.calls.filter((call) => call.startsWith("POST")).length;

    const second = yield* stack.deploy(polarWebhookEndpoint("Webhook", { url }));

    expect(second.id).toBe(first.id);
    expect(polar.calls.filter((call) => call.startsWith("POST")).length).toBe(creates);
    expect(polar.calls.filter((call) => call.startsWith("PATCH"))).toEqual([]);
  }),
);

test.provider(
  "updates url, events, format, enabled and name in one call, and keeps the secret",
  (stack) =>
    Effect.gen(function* () {
      polar.reset();
      const first = yield* stack.deploy(WebhookEndpoint("Webhook", { url }));
      const secret = Redacted.value(first.secret!);

      // From here the vendor answers without the secret, as a read may. State
      // is the only remaining copy, so a provider that trusted the response
      // would replace it with nothing and the Worker would verify nothing.
      polar.hideSecret();

      const second = yield* stack.deploy(
        WebhookEndpoint("Webhook", {
          url: moved,
          events: ["order.paid"],
          format: "slack",
          enabled: false,
          name: "billing",
        }),
      );

      const vendor = polar.endpoints.get(first.id);

      expect(second.id).toBe(first.id);
      expect(vendor?.url).toBe(moved);
      expect(vendor?.events).toEqual(["order.paid"]);
      expect(vendor?.format).toBe("slack");
      expect(vendor?.enabled).toBe(false);
      expect(vendor?.name).toBe(webhookEndpointNameOf(stack.name, stack.stage, "billing"));
      expect(Redacted.value(second.secret!)).toBe(secret);
      expect(polar.calls.filter((call) => call.startsWith("PATCH")).length).toBe(1);
    }),
);

test.provider("adopts the endpoint its name identifies after a lost state", (stack) =>
  Effect.gen(function* () {
    polar.reset();

    // Retain, so the destroy drops only Alchemy's state — the case a lost state
    // store leaves behind — instead of deleting the vendor object.
    const first = yield* stack.deploy(
      polarWebhookEndpoint("Webhook", { url }).pipe(RemovalPolicy.retain()),
    );

    yield* stack.destroy();

    const adopted = yield* stack.deploy(polarWebhookEndpoint("Webhook", { url }));

    expect(adopted.id).toBe(first.id);
    expect(polar.endpoints.size).toBe(1);
    expect(polar.calls.filter((call) => call.startsWith("POST")).length).toBe(1);
  }),
);

test.provider("refuses to adopt an endpoint whose secret it cannot recover", (stack) =>
  Effect.gen(function* () {
    polar.reset();

    yield* stack.deploy(polarWebhookEndpoint("Webhook", { url }).pipe(RemovalPolicy.retain()));
    yield* stack.destroy();

    // A lost state plus an endpoint whose read omits the secret: there is no
    // copy left to verify with, so the deploy refuses rather than storing an
    // endpoint the Worker can never accept a delivery from.
    polar.hideSecret();

    const error = yield* Effect.flip(
      stack.deploy(polarWebhookEndpoint("Webhook", { url }).pipe(RemovalPolicy.retain())),
    );

    expect(error._tag).toBe("PolarWebhookSecretMissing");
    expect(error.endpoint.startsWith("wh_")).toBe(true);
  }),
);

test.provider("deletes the endpoint on destroy", (stack) =>
  Effect.gen(function* () {
    polar.reset();

    const endpoint = yield* stack.deploy(polarWebhookEndpoint("Webhook", { url }));

    expect(polar.endpoints.has(endpoint.id)).toBe(true);

    yield* stack.destroy();

    expect(polar.endpoints.has(endpoint.id)).toBe(false);
  }),
);
