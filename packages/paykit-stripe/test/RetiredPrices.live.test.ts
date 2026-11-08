import * as Stripe from "@alchemy.run/stripe";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { StripeProtocol } from "@distilled.cloud/stripe";
import { GetPrice, GetPrices } from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { StripePrices } from "../src/Prices.ts";
import { RetiredPrices } from "../src/RetiredPrices.ts";

/**
 * `RetiredPrices` against a real test-mode account: a tier leaves the catalog,
 * its price is retained by `StripePrices`, and the sweep turns it off without
 * deleting it.
 *
 * It needs a real Stripe key, so it is gated: without `STRIPE_API_KEY` the case
 * is skipped, and CI stays green with no vendor account. It runs from the
 * manual `live.yml` workflow, which fails rather than skips when the secret is
 * missing.
 *
 * ```sh
 * STRIPE_API_KEY=sk_test_… pnpm --filter @potion.run/paykit-stripe test
 * ```
 *
 * `process.env` at module scope is the one place the Effect rule does not reach:
 * a skip gate runs before any Effect exists.
 */
const apiKey = process.env.STRIPE_API_KEY;
const hasKey = apiKey !== undefined && apiKey !== "";

const { test } = Test.make({ providers: Stripe.providers() });

/** Out-of-band reads, provided the way the vendor package provides them. */
const live = (key: string) =>
  Layer.mergeAll(
    Stripe.credentials({ apiKey: Redacted.make(key) }),
    StripeProtocol,
    FetchHttpClient.layer,
  );

const pro = { amount: 1900, currency: "usd", interval: "month" as const };
const scale = { amount: 19_800, currency: "usd", interval: "annual" as const };

test.provider.skipIf(!hasKey)(
  "archives the price of a tier that left the catalog, and keeps it readable",
  (stack) =>
    Effect.gen(function* () {
      const key = apiKey!;

      // Start from nothing: a previous run's retained prices must not be
      // mistaken for this run's.
      yield* stack.destroy();

      const sold = yield* stack.deploy(StripePrices("Prices", { tiers: { pro, scale } }));
      const scaleKey = sold.prices.scale!;
      const proKey = sold.prices.pro!;

      const before = yield* GetPrices({
        lookup_keys: [scaleKey],
        active: true,
        limit: 1,
      }).pipe(Effect.provide(live(key)));

      expect(before.data.length).toBe(1);
      const scalePriceId = before.data[0]!.id!;

      // The tier leaves the catalog. `StripePrices` retains the price, which is
      // what makes it still sellable — the gap the sweep closes.
      yield* stack.deploy(StripePrices("Prices", { tiers: { pro } }));

      const retired = yield* stack.deploy(RetiredPrices("Retired", { tiers: { pro } }));
      expect(retired.archived).toContain(scalePriceId);
      expect(retired.archived).not.toContain(
        // The tier the catalog still sells is not a candidate.
        (yield* GetPrices({ lookup_keys: [proKey], active: true, limit: 1 }).pipe(
          Effect.provide(live(key)),
        )).data[0]!.id!,
      );

      // Archived: not active, and still there. A bill may reference it.
      const after = yield* GetPrice({ price: scalePriceId }).pipe(Effect.provide(live(key)));
      expect(after.active).toBe(false);
      expect(after.id).toBe(scalePriceId);

      // The tier still in the catalog is untouched.
      const kept = yield* GetPrices({ lookup_keys: [proKey], active: true, limit: 1 }).pipe(
        Effect.provide(live(key)),
      );

      expect(kept.data.length).toBe(1);

      // A second sweep is a no-op: archiving is idempotent, so a deploy that
      // changes nothing archives nothing.
      const again = yield* stack.deploy(RetiredPrices("Retired", { tiers: { pro } }));
      expect(again.archived).toEqual([]);
    }),
);
