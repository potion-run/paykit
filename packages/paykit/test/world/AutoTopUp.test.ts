import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { allowance } from "../../src/Allowance.ts";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import { ConsumeCredits } from "../../src/Billing/ConsumeCredits.binding.ts";
import { BillingApi } from "../../src/BillingApi.api.ts";
import { catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { PaymentsMemory } from "../../src/PaymentsMemory.ts";
import { Entitlements } from "../../src/Subscription/Entitlements.view.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";
import { subscribeInputOf } from "../../src/TierCommand.ts";
import { world } from "../../src/World.ts";

const price = { amount: 1_900, currency: "usd", interval: "month" as const };

/** The plan whose pool a spend below 1,000 should refill. */
const pro = tier({
  id: "pro",
  price,
  credits: 2_000,
  topUp: { threshold: 1_000 },
  grants: [allowance(messages, { included: 100 })],
});

/** The pack a deployment names as the fallback for a line without one. */
const pack = tier({
  id: "pack",
  kind: "one_off",
  price: { amount: 4_900, currency: "usd", interval: "month" },
  credits: 5_000,
  grants: [],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [pro, pack] }));

const account = Subscription.ref("acct_auto_top_up_world");
const asAccount = { headers: { "x-paykit-actor": account.id } };

/**
 * Subscribe, spend 1,500 of the 2,000-credit pool (leaving 500, under the line)
 * and read the pool after the policy has had its turn. The policy reacts after
 * the commit, so the read model catches up rather than the spend waiting on a
 * provider call.
 */
const crossing = (options: { readonly install: boolean }) =>
  Effect.gen(function* () {
    const memory = PaymentsMemory();

    const worldLayer = world({
      catalog: testCatalog,
      providers: [memory],
      guards: InsecureDevGuards,
      ...(options.install ? { autoTopUp: { pack: pack.id } } : {}),
    });

    const credits = yield* Effect.gen(function* () {
      const tenant = yield* BillingApi.clientInProcess;
      const input = subscribeInputOf(testCatalog, pro.id);

      if (input === null) throw new Error("pro is not a subscription tier");

      yield* tenant.Subscribe(account.id, input, asAccount);

      const consume = yield* ConsumeCredits(account.id);
      yield* consume({ amount: 1_500, dedupeKey: "spend-1" });

      const entitlements = yield* Entitlements;

      return yield* Effect.map(entitlements.query(account), Option.getOrNull).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 millis"),
          times: 200,
          until: (view) =>
            options.install ? (view?.credits ?? 0) >= 5_500 : (view?.credits ?? 0) === 500,
        }),
      );
    }).pipe(Effect.provide(worldLayer));

    return { memory, credits: credits?.credits ?? 0 };
  });

describe("the world's auto top-up seam", () => {
  it.live("buys the deployment's pack when a spend crosses the tier's line", () =>
    Effect.gen(function* () {
      const { memory, credits } = yield* crossing({ install: true });

      expect(credits).toBe(5_500);

      // The money is the provider's, and the policy took it at the crossing.
      expect(memory.charges).toHaveLength(1);

      const charge = memory.charges[0];

      expect(charge?.account).toBe(account.id);
      expect(charge?.amount).toBe(4_900);
      expect(charge?.currency).toBe("usd");
    }),
  );

  it.live("leaves the line inert when the deployment does not install the policy", () =>
    Effect.gen(function* () {
      const { memory, credits } = yield* crossing({ install: false });

      // The catalog's line is data; without the policy it buys nothing.
      expect(credits).toBe(500);
      expect(memory.charges).toEqual([]);
    }),
  );
});
