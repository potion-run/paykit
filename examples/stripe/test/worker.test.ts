import { expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import type { StripeEnv } from "../src/Billing.ts";
import Worker from "../src/StripeWorker.ts";

/**
 * A fake key and lookup keys: every path asserted here answers before Stripe is
 * called, so nothing reaches the Stripe API. The values only have to be present.
 */
const env: StripeEnv = {
  STRIPE_SECRET_KEY: "sk_test_worker",
  STRIPE_WEBHOOK_SECRET: "whsec_stripe_worker_secret",
  STRIPE_PRICE_PRO: "paykit_dev_pro",
  STRIPE_MESSAGES_PRICE: "paykit_dev_messages",
  STRIPE_MESSAGES_METER: "paykit_dev_messages",
};

const ask = (path: string, init?: RequestInit) =>
  Effect.promise(() => Worker.fetch(new Request(`https://stripe.example${path}`, init), env));

/**
 * The Worker's own routing is `Paykit.handler`, so these assert the mount points
 * rather than a table this file wrote: `/` is the example's, `/checkout` and
 * `/webhooks` are paykit's, and everything else is paykit's 404.
 */
it.live("serves its own page at / and paykit's 404 everywhere else", () =>
  Effect.gen(function* () {
    const home = yield* ask("/");

    expect(home.status).toBe(200);
    expect(yield* Effect.promise(() => home.json())).toEqual({
      provider: "stripe",
      routes: ["GET /checkout?tier=pro", "POST /webhooks/stripe"],
    });

    const missing = yield* ask("/nightly");

    expect(missing.status).toBe(404);
  }),
);

it.live("mounts the checkout path and answers a request with no account", () =>
  Effect.gen(function* () {
    // No account header: the handler refuses before the provider is asked, which
    // is also what proves the path is mounted and reads `accountOf`.
    const anonymous = yield* ask("/checkout?tier=pro");

    expect(anonymous.status).toBe(401);
  }),
);

it.live("mounts the webhook path and refuses an unsigned delivery", () =>
  Effect.gen(function* () {
    // Stripe's decoder verifies the signature locally, so a delivery with no
    // signature is refused as `WebhookSignatureInvalid` — a 401, not a 202.
    const unsigned = yield* ask("/webhooks/stripe", { method: "POST", body: "{}" });

    expect(unsigned.status).toBe(401);
  }),
);
