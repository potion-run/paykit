import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as DistilledPolar from "@distilled.cloud/polar";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { POLAR_BASE_URL } from "../src/PolarClient.ts";
import { PolarPrices } from "../src/Prices.ts";
import { polarProviders } from "../src/Providers.ts";
import { RetiredProducts } from "../src/RetiredProducts.ts";

/**
 * `RetiredProducts` against a real Polar sandbox: a tier leaves the catalog, its
 * product is retained by `PolarPrices`, and the sweep archives it without
 * deleting it.
 *
 * It needs a real Polar sandbox token, so it is gated: without
 * `POLAR_ACCESS_TOKEN` the case is skipped, and CI stays green with no vendor
 * account. It runs from the manual `live.yml` workflow, which fails rather than
 * skips when the secret is missing. The token is always sent to the sandbox,
 * never production.
 *
 * ```sh
 * POLAR_ACCESS_TOKEN=polar_sandbox_… pnpm --filter @potion.run/paykit-polar test
 * ```
 *
 * `process.env` at module scope is the one place the Effect rule does not
 * reach: a skip gate runs before any Effect exists.
 */
const accessToken = process.env.POLAR_ACCESS_TOKEN;
const hasToken = accessToken !== undefined && accessToken !== "";

const { test } = Test.make({
  providers: polarProviders({
    accessToken: Redacted.make(accessToken ?? ""),
    server: "sandbox",
  }),
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

const readProduct = (id: string) => DistilledPolar.productsGet({ id }).pipe(Effect.provide(live));

/**
 * The two tiers this case sells. They are its own — a product's identity is
 * `(stage, tier)`, so a case that sold a tier another case sells would ask the
 * sandbox for one product and be refused it, correctly.
 */
const keptPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const retiringPrice = { amount: 19_800, currency: "usd", interval: "annual" as const };

test.provider.skipIf(!hasToken)(
  "archives the product of a tier that left the catalog, and keeps it readable",
  (stack) =>
    Effect.gen(function* () {
      // Start from nothing: a previous run's retained products must not be
      // mistaken for this run's. The stage in the name is what keeps the sweep
      // out of the products a previous run left behind.
      yield* stack.destroy();

      const sold = yield* stack.deploy(
        PolarPrices("Prices", { tiers: { kept: keptPrice, retiring: retiringPrice } }),
      );

      const retiredProductId = sold.products.retiring;
      const keptProductId = sold.products.kept;

      const before = yield* readProduct(retiredProductId);
      expect(before.is_archived).toBe(false);

      // The tier leaves the catalog. `PolarPrices` retains the product, which
      // is what leaves it purchasable — the gap the sweep closes.
      yield* stack.deploy(PolarPrices("Prices", { tiers: { kept: keptPrice } }));

      const retained = yield* readProduct(retiredProductId);
      expect(retained.is_archived).toBe(false);

      const retired = yield* stack.deploy(
        RetiredProducts("Retired", { tiers: { kept: keptPrice } }),
      );

      expect(retired.archived).toContain(retiredProductId);
      // The tier the catalog still sells is not a candidate.
      expect(retired.archived).not.toContain(keptProductId);

      // Archived: not purchasable, and still there. An order may reference it.
      const after = yield* readProduct(retiredProductId);
      expect(after.is_archived).toBe(true);
      expect(after.id).toBe(retiredProductId);

      // The tier still in the catalog is untouched and still sellable.
      const stillKept = yield* readProduct(keptProductId);
      expect(stillKept.is_archived).toBe(false);

      // A second sweep is a no-op: archiving is idempotent, so a deploy that
      // changes nothing archives nothing.
      const again = yield* stack.deploy(RetiredProducts("Retired", { tiers: { kept: keptPrice } }));
      expect(again.archived).toEqual([]);
    }),
);
