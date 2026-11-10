import * as Stripe from "@alchemy.run/stripe";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { GetWebhookEndpoint } from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  STRIPE_WEBHOOK_EVENTS,
  stripeWebhookEndpoint,
  stripeWebhookUrl,
} from "../src/WebhookEndpoint.ts";
import { live, stripeLiveKey } from "./support/Live.ts";

/**
 * `stripeWebhookEndpoint` against a real Stripe account: the endpoint the
 * deploy creates, verified through Stripe's own fields rather than from the
 * provider's returned attributes.
 *
 * `WebhookEndpoint.test.ts` beside it is a contract test — it stands in for the
 * vendor provider and asserts what a deploy asks for, which leaves one question
 * open: whether Stripe stores what was asked. This case answers it. It proves
 * the URL and event list as Stripe reports them, the secret minted at create
 * surviving an in-place move to another path, and `destroy` deleting the
 * endpoint — the one vendor object paykit does not retain, because a retired
 * deployment must stop receiving deliveries.
 *
 * It needs a real key, so it is gated: without `STRIPE_API_KEY` the case is
 * skipped, and CI stays green with no vendor account. The key must be test-mode
 * (`sk_test_`/`rk_test_`); a live key fails the file rather than running. Run it
 * with a test-mode key:
 *
 * ```sh
 * STRIPE_API_KEY=sk_test_… pnpm --filter @potion.run/paykit-stripe test
 * ```
 *
 * `process.env` at module scope is the one place the Effect rule does not
 * reach: a skip gate runs before any Effect exists.
 */
const apiKey = stripeLiveKey(process.env.STRIPE_API_KEY);
const hasKey = apiKey !== undefined;

const { test } = Test.make({ providers: Stripe.providers() });

/** Out-of-band reads, provided the way the vendor package provides them. */
const readEndpoint = (key: string, id: string) =>
  GetWebhookEndpoint({ webhook_endpoint: id }).pipe(Effect.provide(live(key)));

test.provider.skipIf(!hasKey)(
  "creates the endpoint the deploy states, keeps it in place on a move, and deletes it on destroy",
  (stack) =>
    Effect.gen(function* () {
      const key = apiKey!;

      // Clear this test's state first: a previous run's endpoint must not be
      // adopted as this run's.
      yield* stack.destroy();

      const url = stripeWebhookUrl("https://example.com");
      const first = yield* stack.deploy(stripeWebhookEndpoint("Delivery", { url }));

      expect(first.url).toBe(url);
      expect(first.status).toBe("enabled");

      // Stripe mints the secret at create and never returns it again, so this is
      // the only moment it can be read. It is what the Worker verifies with.
      const secret = Redacted.value(first.secret!);
      expect(secret.startsWith("whsec_")).toBe(true);

      // Out of band: Stripe is the authority for what the endpoint does, and its
      // event list is the half no local assertion covers.
      const created = yield* readEndpoint(key, first.id);

      expect(created.url).toBe(url);
      expect([...created.enabled_events].sort()).toEqual([...STRIPE_WEBHOOK_EVENTS].sort());
      expect(created.status).toBe("enabled");
      expect(created.livemode).toBe(false);

      // A moved path is an update, not a replacement: one endpoint, the same
      // secret, so changing the route never leaves the deployment without a
      // verifier.
      const moved = stripeWebhookUrl("https://example.com", "/billing/stripe");
      const second = yield* stack.deploy(stripeWebhookEndpoint("Delivery", { url: moved }));

      expect(second.id).toBe(first.id);
      expect(Redacted.value(second.secret!)).toBe(secret);

      const updated = yield* readEndpoint(key, first.id);

      expect(updated.url).toBe(moved);
      expect(updated.status).toBe("enabled");

      // Destroy deletes it. Stripe answers a read for a deleted endpoint with
      // `NotFound`, or with `resource_missing` inside an invalid request.
      yield* stack.destroy();

      const missing = yield* readEndpoint(key, first.id).pipe(
        Effect.catchTag(["NotFound", "InvalidRequestError"], () =>
          Effect.succeed("missing" as const),
        ),
      );

      expect(missing).toBe("missing");
    }),
);
