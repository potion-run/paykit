import * as Stripe from "@alchemy.run/stripe";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { GetPrice, GetPrices } from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { StripePrices } from "../src/Prices.ts";
import { RetiredPrices } from "../src/RetiredPrices.ts";
import { live, stripeLiveKey } from "./support/Live.ts";

/**
 * `RetiredPrices` against a real test-mode account: a tier leaves the catalog,
 * its price is retained by `StripePrices`, and the sweep turns it off without
 * deleting it.
 *
 * It needs a real Stripe key, so it is gated: without `STRIPE_API_KEY` the case
 * is skipped, and CI stays green with no vendor account. The key must be
 * test-mode (`sk_test_`/`rk_test_`); a live key fails the file rather than
 * running, because the sweep turns off real prices. It runs from the manual
 * `live.yml` workflow, which fails rather than skips when the secret is missing.
 *
 * ```sh
 * STRIPE_API_KEY=sk_test_… pnpm --filter @potion.run/paykit-stripe test
 * ```
 *
 * `process.env` at module scope is the one place the Effect rule does not reach:
 * a skip gate runs before any Effect exists.
 */
const apiKey = stripeLiveKey(process.env.STRIPE_API_KEY);
const hasKey = apiKey !== undefined;

/**
 * This case runs in **its own stage**, which is what makes its sweep safe: the
 * sweep archives every active price of its stage that its catalog does not
 * declare, and `alchemy-test` runs files concurrently. Sharing the default
 * stage with `Prices.live.test.ts` would have it archive that suite's prices —
 * and a price another file created between the two sweeps would make the
 * second one non-empty and the idempotence assertion flaky.
 */
const { test } = Test.make({
  stage: `${Test.defaultStage()}_retired`,
  providers: Stripe.providers(),
});

const pro = { amount: 1900, currency: "usd", interval: "month" as const };
const scale = { amount: 19_800, currency: "usd", interval: "annual" as const };

test.provider.skipIf(!hasKey)(
  "archives the price of a tier that left the catalog, and keeps it readable",
  (stack) =>
    Effect.gen(function* () {
      const key = apiKey!;

      // Clear this test's state. The provider's prices are retained by design,
      // so a previous run's retained prices are adopted by their metadata, not
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

      const kept = yield* GetPrices({
        lookup_keys: [proKey],
        active: true,
        limit: 1,
      }).pipe(Effect.provide(live(key)));

      expect(kept.data.length).toBe(1);
      const proPriceId = kept.data[0]!.id!;

      // The tier leaves the catalog. `StripePrices` retains the price, which is
      // what makes it still sellable — the gap the sweep closes.
      yield* stack.deploy(StripePrices("Prices", { tiers: { pro } }));

      const retired = yield* stack.deploy(RetiredPrices("Retired", { tiers: { pro } }));
      expect(retired.archived).toContain(scalePriceId);
      // The tier the catalog still sells is not a candidate.
      expect(retired.archived).not.toContain(proPriceId);

      // Archived: not active, and still there. A bill may reference it.
      const after = yield* GetPrice({ price: scalePriceId }).pipe(Effect.provide(live(key)));
      expect(after.active).toBe(false);
      expect(after.id).toBe(scalePriceId);

      // The tier still in the catalog is untouched.
      const stillKept = yield* GetPrices({ lookup_keys: [proKey], active: true, limit: 1 }).pipe(
        Effect.provide(live(key)),
      );

      expect(stillKept.data.length).toBe(1);

      // A second sweep is a no-op: archiving is idempotent, so a deploy that
      // changes nothing archives nothing.
      const again = yield* stack.deploy(RetiredPrices("Retired", { tiers: { pro } }));
      expect(again.archived).toEqual([]);

      // A replacement is a new price under the same key. The superseded price
      // keeps its object and stays active, but Stripe moves the one lookup key
      // onto the replacement, so the sweep cannot see it — and does not.
      const replaced = yield* stack.deploy(
        StripePrices("Prices", { tiers: { pro: { ...pro, amount: 2_400 } } }),
      );

      const current = yield* GetPrices({
        lookup_keys: [replaced.prices.pro],
        active: true,
        limit: 1,
      }).pipe(Effect.provide(live(key)));

      expect(current.data.length).toBe(1);
      const currentPriceId = current.data[0]!.id!;

      const superseded = yield* GetPrice({ price: proPriceId }).pipe(Effect.provide(live(key)));
      expect(superseded.active).toBe(true);
      expect(superseded.lookup_key).toBe(null);

      const afterReplacement = yield* stack.deploy(
        RetiredPrices("Retired", { tiers: { pro: { ...pro, amount: 2_400 } } }),
      );

      expect(afterReplacement.archived).toEqual([]);

      // When the tier finally leaves, the sweep archives the generation that
      // still carries the key. The superseded one has no key, so it stays
      // active: retention is older than the sweep, and a sweep by lookup key
      // cannot find it.
      yield* stack.deploy(StripePrices("Prices", { tiers: {} }));

      const emptied = yield* stack.deploy(RetiredPrices("Retired", { tiers: {} }));
      expect(emptied.archived).toContain(currentPriceId);
      expect(emptied.archived).not.toContain(proPriceId);

      const currentAfter = yield* GetPrice({ price: currentPriceId }).pipe(
        Effect.provide(live(key)),
      );

      expect(currentAfter.active).toBe(false);

      const supersededAfter = yield* GetPrice({ price: proPriceId }).pipe(
        Effect.provide(live(key)),
      );

      expect(supersededAfter.active).toBe(true);
    }),
);
