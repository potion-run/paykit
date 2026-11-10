import * as Stripe from "@alchemy.run/stripe";
import { StripeProtocol } from "@distilled.cloud/stripe";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/**
 * The key a live suite is allowed to write with.
 *
 * Stripe's test mode is a property of the key, not a flag on the client: the
 * same API host answers both, and only the key decides which account is
 * touched. A live key would create real prices, and the `RetiredPrices` sweep
 * would deactivate real ones. A non-empty key that is not test-mode therefore
 * throws here, before any case registers — `skipIf` would report green having
 * written nothing, which is the one result a live suite must never produce.
 *
 * `process.env` at module scope is the one place the Effect rule does not
 * reach: a skip gate runs before any Effect exists, and a misconfigured key is
 * a load-time refusal.
 */
export const stripeLiveKey = (environment: string | undefined): string | undefined => {
  if (environment === undefined || environment === "") return undefined;

  if (!/^(sk|rk)_test_/.test(environment)) {
    throw new Error(
      "STRIPE_API_KEY is not a test-mode key (sk_test_/rk_test_); refusing to run the live suite",
    );
  }

  return environment;
};

/** Out-of-band reads, provided the way the vendor package provides them. */
export const live = (key: string) =>
  Layer.mergeAll(
    Stripe.credentials({ apiKey: Redacted.make(key) }),
    StripeProtocol,
    FetchHttpClient.layer,
  );
