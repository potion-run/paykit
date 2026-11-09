import * as Stripe from "@alchemy.run/stripe";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { StripeProtocol } from "@distilled.cloud/stripe";
import { GetPrice, GetPrices } from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { registerMeteredPriceProvider } from "../src/MeteredPrice.ts";
import { StripePrices } from "../src/Prices.ts";

/**
 * The engine half of `StripePrices`, tested the way Alchemy tests a resource:
 * `test.provider` with a scratch stack, `stack.deploy` and `stack.destroy`, and
 * the cloud state verified out of band through distilled.
 *
 * It needs a real Stripe key, so it is gated: without `STRIPE_API_KEY` the case
 * is skipped, and CI stays green with no vendor account. Run it with a test-mode
 * key:
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

// `Stripe.providers()` cannot enumerate a provider from this package, so put it
// into the collection while that layer is built. This is the layer cleanup
// builds too: registering from inside a reconcile is too late for a failed
// case's teardown, which then cannot delete (or orphan) its state rows.
const providers = Layer.effectDiscard(registerMeteredPriceProvider).pipe(
  Layer.provideMerge(Stripe.providers()),
);

const { test } = Test.make({ providers });

/** Out-of-band reads, provided the way the vendor package provides them. */
const live = (key: string) =>
  Layer.mergeAll(
    Stripe.credentials({ apiKey: Redacted.make(key) }),
    StripeProtocol,
    FetchHttpClient.layer,
  );

const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };

test.provider.skipIf(!hasKey)(
  "creates the price the catalog states, replaces it on a change, and keeps the old one",
  (stack) =>
    Effect.gen(function* () {
      const key = apiKey!;

      // Start from nothing: a previous run's prices must not be mistaken for this
      // run's.
      yield* stack.destroy();

      const first = yield* stack.deploy(StripePrices("Prices", { tiers: { pro: proPrice } }));
      const lookupKey = first.prices.pro;

      // The key is the stage and the tier, not the id.
      expect(lookupKey.startsWith("paykit:")).toBe(true);
      expect(lookupKey.endsWith(":pro")).toBe(true);

      const created = yield* GetPrices({ lookup_keys: [lookupKey], active: true, limit: 1 }).pipe(
        Effect.provide(live(key)),
      );

      expect(created.data.length).toBe(1);
      const createdPrice = created.data[0];
      expect(createdPrice?.unit_amount).toBe(1900);
      expect(createdPrice?.currency).toBe("usd");
      expect(createdPrice?.recurring?.interval).toBe("month");
      expect(createdPrice?.id).toBeDefined();

      // A changed amount is a replacement: Stripe prices are create-only, so a
      // new price answers for the same lookup key.
      const second = yield* stack.deploy(
        StripePrices("Prices", { tiers: { pro: { ...proPrice, amount: 2400 } } }),
      );

      expect(second.prices.pro).toBe(lookupKey);

      const replaced = yield* GetPrices({ lookup_keys: [lookupKey], active: true, limit: 1 }).pipe(
        Effect.provide(live(key)),
      );

      expect(replaced.data[0]?.unit_amount).toBe(2400);
      expect(replaced.data[0]?.id).not.toBe(createdPrice?.id);

      // The old price is retained: not deleted, and still readable, because an
      // invoice may reference it. It is not archived either — retention is not
      // archival, and the docs say so.
      const previous = yield* GetPrice({ price: createdPrice!.id! }).pipe(
        Effect.provide(live(key)),
      );

      expect(previous.id).toBe(createdPrice?.id);

      // A tier that leaves the catalog is retained the same way.
      yield* stack.deploy(StripePrices("Prices", { tiers: {} }));
      const retired = yield* GetPrice({ price: createdPrice!.id! }).pipe(Effect.provide(live(key)));
      expect(retired.id).toBe(createdPrice?.id);
    }),
);

const packPrice = { amount: 9_900, currency: "usd", interval: "month" as const };

test.provider.skipIf(!hasKey)("creates a one-time price for a one-off pack", (stack) =>
  Effect.gen(function* () {
    const key = apiKey!;
    yield* stack.destroy();

    const sold = yield* stack.deploy(
      StripePrices("Prices", {
        tiers: { credits: { price: packPrice, kind: "one_off" } },
      }),
    );

    const creditKey = sold.prices.credits;

    const created = yield* GetPrices({
      lookup_keys: [creditKey],
      active: true,
      limit: 1,
    }).pipe(Effect.provide(live(key)));

    const price = created.data[0];
    expect(price?.unit_amount).toBe(9_900);
    // A pack is charged once; a recurring price would make `mode=payment`
    // unusable and would start a subscription instead.
    expect(price?.recurring).toBe(null);
  }),
);

test.provider.skipIf(!hasKey)(
  "creates a meter and a metered price from the catalog's unit price",
  (stack) =>
    Effect.gen(function* () {
      const key = apiKey!;
      yield* stack.destroy();

      const sold = yield* stack.deploy(
        StripePrices("Prices", {
          tiers: {
            pro: {
              price: proPrice,
              usage: { messages: { amount: 2, currency: "usd" } },
            },
          },
        }),
      );

      const meteredKey = sold.usage.pro.messages;

      const created = yield* GetPrices({
        lookup_keys: [meteredKey],
        active: true,
        limit: 1,
      }).pipe(Effect.provide(live(key)));

      const price = created.data[0];
      expect(price?.unit_amount).toBe(2);
      expect(price?.currency).toBe("usd");
      expect(price?.recurring?.usage_type).toBe("metered");
      expect(price?.recurring?.meter).toBeDefined();
      expect(sold.meters.messages.startsWith("paykit_")).toBe(true);
    }),
);

test.provider.skipIf(!hasKey)(
  "creates a package transform and a tiered price, and keeps the replaced ladder",
  (stack) =>
    Effect.gen(function* () {
      const key = apiKey!;
      yield* stack.destroy();

      const tiers = {
        package: {
          price: proPrice,
          usage: { messages: { kind: "unit", amount: 500, currency: "usd", units: 1_000 } },
        },
        ladder: {
          price: proPrice,
          usage: {
            messages: {
              kind: "graduated",
              currency: "usd",
              bands: [
                { upTo: 100, amount: 1, currency: "usd" },
                { upTo: "inf", amount: 2, currency: "usd" },
              ],
            },
          },
        },
      } as const;

      const sold = yield* stack.deploy(StripePrices("Prices", { tiers }));

      // The list endpoint answers the lookup key; retrieve that id for the
      // whole Price. A list response is not the object to assert transforms and
      // tiers on.
      const priceOf = (lookupKey: string) =>
        GetPrices({ lookup_keys: [lookupKey], active: true, limit: 1 }).pipe(
          Effect.provide(live(key)),
          Effect.flatMap((prices) => {
            const found = prices.data[0];

            return found === undefined
              ? Effect.succeed(undefined)
              : GetPrice({ price: found.id }).pipe(Effect.provide(live(key)));
          }),
        );

      const packagePrice = yield* priceOf(sold.usage.package.messages);
      // `per_unit` is Stripe's default and is not what makes this a package;
      // the transform is. Assert the fields that carry the catalog's decision.
      expect(packagePrice?.unit_amount).toBe(500);
      expect(packagePrice?.transform_quantity).toEqual({ divide_by: 1_000, round: "up" });

      const ladderPrice = yield* priceOf(sold.usage.ladder.messages);
      expect(ladderPrice?.billing_scheme).toBe("tiered");
      expect(ladderPrice?.tiers_mode).toBe("graduated");
      expect(
        ladderPrice?.tiers?.map((tier) => ({ upTo: tier.up_to, amount: tier.unit_amount })),
      ).toEqual([
        { upTo: 100, amount: 1 },
        { upTo: null, amount: 2 },
      ]);

      const changed = yield* stack.deploy(
        StripePrices("Prices", {
          tiers: {
            ...tiers,
            ladder: {
              ...tiers.ladder,
              usage: {
                messages: {
                  ...tiers.ladder.usage.messages,
                  bands: [
                    { upTo: 100, amount: 1, currency: "usd" },
                    { upTo: "inf", amount: 3, currency: "usd" },
                  ],
                },
              },
            },
          },
        }),
      );

      const replaced = yield* priceOf(changed.usage.ladder.messages);
      expect(replaced?.id).not.toBe(ladderPrice?.id);
      const previous = yield* GetPrice({ price: ladderPrice!.id! }).pipe(Effect.provide(live(key)));
      expect(previous.id).toBe(ladderPrice?.id);
    }),
);
