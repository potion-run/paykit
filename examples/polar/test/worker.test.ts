import { expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import type { PolarEnv } from "../src/Billing.ts";
import Worker from "../src/PolarWorker.ts";

/**
 * A fake token and ids: every path asserted here answers before the provider is
 * called, so nothing reaches Polar's API. The ids only have to be present.
 */
const env: PolarEnv = {
  POLAR_ACCESS_TOKEN: "polar_sandbox_test",
  POLAR_WEBHOOK_SECRET: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  POLAR_PRODUCT_PRO: "prod_test",
  POLAR_MESSAGES_METER: "meter_test",
};

const ask = (path: string, init?: RequestInit) =>
  Effect.promise(() => Worker.fetch(new Request(`https://polar.example${path}`, init), env));

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
      provider: "polar",
      routes: ["GET /checkout?tier=pro", "POST /webhooks/polar"],
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
    // Polar's decoder verifies the signature locally, so a delivery with no
    // signature is refused as `WebhookSignatureInvalid` — a 401, not a 202.
    const unsigned = yield* ask("/webhooks/polar", { method: "POST", body: "{}" });

    expect(unsigned.status).toBe(401);
  }),
);
