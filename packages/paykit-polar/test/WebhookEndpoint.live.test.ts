import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as DistilledPolar from "@distilled.cloud/polar";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { POLAR_BASE_URL } from "../src/PolarClient.ts";
import { polarProviders } from "../src/Providers.ts";
import {
  POLAR_WEBHOOK_EVENTS,
  polarWebhookEndpoint,
  webhookEndpointNameOf,
} from "../src/WebhookEndpoint.ts";

/**
 * `Polar.WebhookEndpoint` against a real Polar sandbox: the endpoint the deploy
 * creates, verified through Polar's own fields out of band.
 *
 * `WebhookEndpoint.provider.test.ts` beside it fakes the HTTP transport, which
 * proves the lifecycle but asks Polar nothing. This case closes that gap: the
 * name Polar stored (the only ownership evidence Polar keeps, since its endpoint
 * has no metadata field), the URL, the event list and the format as the vendor
 * reports them, the secret surviving an in-place move, and `destroy` deleting
 * the endpoint.
 *
 * It needs a real sandbox token, so it is gated: without `POLAR_API_KEY`
 * the case is skipped, and CI stays green with no vendor account. The token is
 * always sent to the sandbox, never production. Run it with a sandbox token:
 *
 * ```sh
 * POLAR_API_KEY=polar_sandbox_… pnpm --filter @potion.run/paykit-polar test
 * ```
 *
 * The endpoint is `destroy`, not retained, so a run leaves nothing behind.
 *
 * `process.env` at module scope is the one place the Effect rule does not
 * reach: a skip gate runs before any Effect exists.
 */
const accessToken = process.env.POLAR_API_KEY;
const hasToken = accessToken !== undefined && accessToken !== "";

const { test } = Test.make({
  providers: polarProviders({ server: "sandbox" }),
});

/** Out-of-band reads, provided the way the vendor package provides them. */
const live = Layer.mergeAll(
  DistilledPolar.fromApiKey({
    apiKey: Redacted.make(accessToken ?? ""),
    apiBaseUrl: POLAR_BASE_URL.sandbox,
  }),
  DistilledPolar.PolarProtocol,
  FetchHttpClient.layer,
);

const readEndpoint = (id: string) =>
  DistilledPolar.webhooksGetWebhookEndpoint({ id }).pipe(Effect.provide(live));

test.provider.skipIf(!hasToken)(
  "creates the endpoint under the scope's name, keeps it in place on a move, and deletes it on destroy",
  (stack) =>
    Effect.gen(function* () {
      // Clear this test's state first: a previous run's endpoint must not be
      // adopted as this run's.
      yield* stack.destroy();

      const url = "https://example.com/webhooks/polar";
      const first = yield* stack.deploy(polarWebhookEndpoint("Delivery", { url }));

      // Polar returns the secret at create and never again, so this is the only
      // moment it can be read. The endpoint's state is the only copy after it.
      const secret = Redacted.value(first.secret!);
      expect(secret.length > 0).toBe(true);

      // Out of band: Polar is the authority for what the endpoint does. The name
      // is the identity a state-lost deploy finds the endpoint by, so it is the
      // assertion that matters most here.
      const created = yield* readEndpoint(first.id);

      expect(created.name).toBe(webhookEndpointNameOf(stack.name, stack.stage));
      expect(created.url).toBe(url);
      expect(created.format).toBe("raw");
      expect([...created.events].sort()).toEqual([...POLAR_WEBHOOK_EVENTS].sort());
      expect(created.enabled).toBe(true);

      // A moved path updates the endpoint in place: one id, the same secret,
      // because a replacement would mint a new one and the Worker would keep
      // verifying against a secret the vendor no longer signs with.
      const moved = "https://example.com/billing/polar";
      const second = yield* stack.deploy(polarWebhookEndpoint("Delivery", { url: moved }));

      expect(second.id).toBe(first.id);
      expect(Redacted.value(second.secret!)).toBe(secret);

      const updated = yield* readEndpoint(first.id);

      expect(updated.url).toBe(moved);

      // Destroy deletes it: a retired deployment must stop receiving deliveries,
      // which is the one place the "retain financial history" rule does not
      // apply.
      yield* stack.destroy();

      const missing = yield* readEndpoint(first.id).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed("missing" as const)),
      );

      expect(missing).toBe("missing");
    }),
);
