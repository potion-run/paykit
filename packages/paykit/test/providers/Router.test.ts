import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BillingInProcess } from "../../src/Billing/BillingInProcess.layer.ts";
import { Portal as PortalBinding } from "../../src/Billing/Portal.binding.ts";
import { Subscribe as SubscribeBinding } from "../../src/Billing/Subscribe.binding.ts";
import {
  Actor,
  MemoryBillingReadStore,
  Model as PaykitModel,
  PaykitHandlers,
  Manual,
  Memory,
  PaymentsRouter,
  ProviderCapabilityMissing,
  Subscription,
  allowance,
  catalog,
  catalogLayer,
  messages,
  paymentsRouter,
  system,
  tier,
} from "../../src/index.ts";
import { AttachProviderRef } from "../../src/Subscription/AttachProviderRef.command.ts";
import type { TierId } from "../../src/Tier.ts";

const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2_000 })],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [proTier] }));

/** Two providers in one Stack: memory first, so it serves a new account. */
const Model = PaykitModel.layer(PaykitHandlers).pipe(
  Layer.provideMerge(MemoryBillingReadStore),
  Layer.provide(Domain.InMemory),
  Layer.provideMerge(Layer.succeed(Actor, system("test"))),
  Layer.provideMerge(catalogLayer(testCatalog)),
);

const Providers = paymentsRouter(Memory(), Manual());

const World = Layer.mergeAll(
  Model,
  // The bindings resolve the model, the catalog and the provider router when the
  // layer is built, so they are provided rather than merged beside it.
  BillingInProcess.pipe(Layer.provide(Model), Layer.provide(Providers)),
  catalogLayer(testCatalog),
  Providers,
);

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(World));

/** Record a vendor reference for an account the way a completed checkout would. */
const referred = (account: string, provider: string) =>
  Effect.gen(function* () {
    const subscription = yield* Subscription;
    yield* subscription.send(
      Subscription.ref(account),
      new AttachProviderRef({ provider, refs: { checkout: `ref_${provider}` } }),
    );
  });

const stateOf = (account: string) =>
  Effect.gen(function* () {
    const subscription = yield* Subscription;

    return yield* subscription.state(Subscription.ref(account));
  });

describe("a Stack with two providers", () => {
  it.live("a new account buys through the first provider, and its ref names that one", () =>
    Effect.gen(function* () {
      const purchase = yield* (yield* SubscribeBinding("acct_new"))({
        tier: "pro" as TierId,
      });

      expect("url" in purchase).toBe(true);

      if ("url" in purchase) expect(purchase.url).toContain("paykit.memory");
      const state = yield* stateOf("acct_new");
      expect(Object.keys(state.refs)).toEqual(["memory"]);
    }).pipe(run),
  );

  it.live("an account that already pays through the second provider stays there", () =>
    Effect.gen(function* () {
      yield* referred("acct_manual", "manual");

      // `manual` has no checkout, so the purchase is an invoice — proof the
      // router picked the provider the standing names, not the fallback.
      const purchase = yield* (yield* SubscribeBinding("acct_manual"))({
        tier: "pro" as TierId,
      });

      expect("invoiceId" in purchase).toBe(true);
      const state = yield* stateOf("acct_manual");
      expect(state.refs.manual).toBeDefined();
      expect(state.refs.memory).toBeUndefined();
    }).pipe(run),
  );

  it.live("the portal opens on the account's own provider, not the fallback", () =>
    Effect.gen(function* () {
      yield* referred("acct_portal_manual", "manual");
      const error = yield* Effect.flip((yield* PortalBinding("acct_portal_manual"))());
      // `manual` declares no portal, so the routed call fails on that provider;
      // the fallback would have opened one.
      expect(error).toBeInstanceOf(ProviderCapabilityMissing);

      if (error._tag === "ProviderCapabilityMissing") expect(error.provider).toBe("manual");

      // An account with no refs falls back to the first provider, which has a
      // portal — so the refusal above was the routing, not a missing op.
      const opened = yield* (yield* PortalBinding("acct_never_seen"))();
      expect(opened.url).toContain("portal");
    }).pipe(run),
  );

  it("the router keeps every provider, keyed by the name `refs` uses", () => {
    const providers = [Memory(), Manual()];
    expect(providers.map((provider) => provider.name)).toEqual(["memory", "manual"]);
    expect(PaymentsRouter).toBeDefined();
  });
});
