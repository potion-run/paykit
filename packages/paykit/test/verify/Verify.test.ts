import * as Domain from "@alchemy.run/domain";
import { expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog, type Catalog } from "../../src/Catalog.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { PaymentsProvider } from "../../src/Payments.ts";
import { AttachProviderRef } from "../../src/Subscription/AttachProviderRef.command.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import type { SubscriptionState } from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";
import { Verify, verifyState } from "../../src/Verify.ts";

const freeTier = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });
const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});
const testCatalog: Catalog = Effect.runSync(
  catalog({ features: [messages], tiers: [freeTier, proTier] }),
);
const free = allowancesOf(testCatalog, "free")!;
const pro = allowancesOf(testCatalog, "pro")!;
const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const account = "acct_verify";

const subscribed = (tierId: string, state?: Partial<SubscriptionState>): SubscriptionState =>
  ({
    _tag: "Subscribed",
    tier: tierId,
    status: "active",
    period: {
      start: new Date("2030-01-01T00:00:00Z"),
      end: new Date("2030-02-01T00:00:00Z"),
      anchorTz: "UTC",
    },
    interval: "month",
    cancelAtPeriodEnd: false,
    credits: 0,
    usage: {},
    remaining: {},
    reserved: {},
    allowances: {},
    refs: {},
    trialUsed: false,
    dedupeKeys: {},
    dunningAttempts: 0,
    ...state,
  }) as unknown as SubscriptionState;

const processor = {
  name: "stripe",
  capabilities: new Set(["checkout", "refund"] as const),
} as { readonly name: string; readonly capabilities: ReadonlySet<"checkout"> };

it("a priced standing with no vendor reference is drift", () => {
  const mismatches = verifyState(account, subscribed("pro"), {
    catalog: testCatalog,
    provider: processor,
  });
  expect(mismatches.length).toBe(1);
  expect(mismatches[0]?._tag).toBe("MissingProviderRef");
});

it("a priced standing with its vendor reference is clean", () => {
  const mismatches = verifyState(
    account,
    subscribed("pro", { refs: { stripe: { customer: "cus_1" } } }),
    { catalog: testCatalog, provider: processor },
  );
  expect(mismatches).toEqual([]);
});

it("a free standing needs no vendor reference", () => {
  const mismatches = verifyState(account, subscribed("free"), {
    catalog: testCatalog,
    provider: processor,
  });
  expect(mismatches).toEqual([]);
});

it("a vendor reference with no standing is drift", () => {
  const mismatches = verifyState(
    account,
    { _tag: "Unsubscribed", refs: { stripe: { checkout: "cs_1" } } },
    { catalog: testCatalog, provider: processor },
  );
  expect(mismatches[0]?._tag).toBe("OrphanProviderRef");
});

it("a sold tier no provider can charge is drift", () => {
  const mismatches = verifyState(
    account,
    subscribed("pro", { refs: { stripe: { customer: "cus_1" } } }),
    {
      catalog: testCatalog,
      provider: { name: "stripe", capabilities: new Set(["refund"]) },
    },
  );
  expect(mismatches[0]?._tag).toBe("TierHasNoPurchasePath");
});

const World = PaykitModel.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)))
  .pipe(Layer.provide(Domain.InMemory))
  .pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(Actor, system("test")),
        catalogLayer(testCatalog),
        Layer.succeed(PaymentsProvider, {
          name: "stripe",
          capabilities: new Set(["checkout", "refund"] as const),
        }),
      ),
    ),
  );

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(World));

it.live("verify finds a checkout that attached no vendor reference", () =>
  Effect.gen(function* () {
    const subscription = yield* Subscription;
    yield* subscription.send(
      Subscription.ref(account),
      new Subscribe({ tier: "pro", allowances: pro, price: proPrice }),
    );
    const verify = yield* Verify();
    const mismatches = yield* verify({ account });
    expect(mismatches.map((mismatch) => mismatch._tag)).toEqual(["MissingProviderRef"]);
  }).pipe(run),
);

it.live("verify is clean once the vendor reference is attached", () =>
  Effect.gen(function* () {
    const subscription = yield* Subscription;
    const ref = Subscription.ref(account);
    yield* subscription.send(ref, new Subscribe({ tier: "pro", allowances: pro, price: proPrice }));
    yield* subscription.send(
      ref,
      new AttachProviderRef({ provider: "stripe", refs: { customer: "cus_1" } }),
    );
    const verify = yield* Verify();
    expect(yield* verify({ account })).toEqual([]);
  }).pipe(run),
);

it.live("a free standing verifies without a provider at all", () =>
  Effect.gen(function* () {
    const subscription = yield* Subscription;
    yield* subscription.send(
      Subscription.ref(account),
      new Subscribe({ tier: "free", allowances: free }),
    );
    const verify = yield* Verify();
    expect(yield* verify({ account })).toEqual([]);
  }).pipe(run),
);
