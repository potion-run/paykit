import { describe, expect, it } from "@alchemy.run/test";
import { moneyRoutes, Paykit, Subscription } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import { Provider } from "../src/billing.config.ts";
import { MemoryLive } from "../src/Billing.layer.ts";
import { billingCatalog, free, messages, pro } from "../src/catalog.ts";

const account = Subscription.ref("acct_memory_example");

describe("the in-memory example", () => {
  it.live("sells a free tier, records usage and answers the next check", () =>
    Effect.gen(function* () {
      const subscribe = yield* Paykit.Subscribe(account.id);

      expect(yield* subscribe({ tier: free.id })).toEqual({ activated: true });

      const track = yield* Paykit.TrackUsage(account.id);
      yield* track({ featureId: messages.id, value: 5, idempotencyKey: "req_1" });

      const check = yield* Paykit.Check(account.id);
      const answer = yield* check({ featureId: messages.id, requiredBalance: 1 });

      expect(answer.allowed).toBe(true);
      expect(answer.balance.remaining).toBe(95);
      expect(answer.standing).toBe("good");
    }).pipe(Effect.provide(MemoryLive)),
  );

  it.live("the manual provider sells a priced tier through an invoice", () =>
    Effect.gen(function* () {
      const routes = yield* moneyRoutes(Provider);
      const purchase = yield* routes.purchase(account.id, pro.id);

      expect("invoiceId" in purchase).toBe(true);

      // The provider has no delivery to verify, which the route turns into a 501.
      const error = yield* Effect.flip(routes.deliver({ headers: {}, body: "{}" }));

      expect(error._tag).toBe("ProviderCapabilityMissing");
    }).pipe(Effect.provide(MemoryLive)),
  );

  it("the catalog is the one the deploy validates", () => {
    expect(billingCatalog.tiers.map((tier) => tier.id)).toEqual(["free", "pro"]);
    expect(billingCatalog.features.map((feature) => feature.id)).toEqual(["messages"]);
  });
});
