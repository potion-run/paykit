import * as Domain from "@alchemy.run/domain";
import { expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../src/Allowance.ts";
import { BillingAdminApi } from "../src/BillingAdminApi.api.ts";
import { BillingApi } from "../src/BillingApi.api.ts";
import { MemoryBillingReadStore } from "../src/BillingReadStore.ts";
import { allowancesOf, catalog } from "../src/Catalog.ts";
import { messages } from "../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../src/Paykit.model.ts";
import { Subscription } from "../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../src/Tier.ts";

const freeTier = tier({
  id: "free",
  grants: [allowance(messages, { included: 100 })],
});
const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [freeTier] }));
const free = allowancesOf(testCatalog, "free")!;
const account = Subscription.ref("acct_api");

const World = PaykitModel.layer(PaykitHandlers)
  .pipe(Layer.provideMerge(MemoryBillingReadStore))
  .pipe(Layer.provide(Domain.InMemory));

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(World));

it.live("an admin grants credits through the command, then reads Entitlements", () =>
  Effect.gen(function* () {
    const admin = yield* BillingAdminApi.clientInProcess;
    const tenant = yield* BillingApi.clientInProcess;
    yield* tenant.Subscribe(account.id, { tier: "free", allowances: free });
    const granted = yield* admin.GrantCredits(account.id, { amount: 250 });
    expect(granted.reply).toEqual({ balance: 250 });
    const state = yield* admin.BillingState.get(account.id, { atLeast: granted });
    expect(state?.credits).toBe(250);
    const entitlements = yield* admin.Entitlements.get(account.id, { atLeast: granted });
    expect(entitlements?.tier).toBe("free");
    expect(entitlements?.standing).toBe("good");
    const whole = yield* admin.Subscription.get(account.id);
    expect(whole?._tag).toBe("Subscribed");
    if (whole?._tag === "Subscribed") expect(whole.credits).toBe(250);
  }).pipe(run),
);

it.live("the tenant surface tracks usage but cannot grant credits", () =>
  Effect.gen(function* () {
    const tenant = yield* BillingApi.clientInProcess;
    yield* tenant.Subscribe(account.id, { tier: "free", allowances: free });
    const tracked = yield* tenant.TrackUsage(account.id, { feature: "messages", amount: 5 });
    expect(tracked.stream).toContain("Subscription/");
    // The tenant surface does not serve the admin command at all.
    expect("GrantCredits" in tenant).toBe(false);
    expect("ChangeTier" in tenant).toBe(true);
  }).pipe(run),
);

it.live("both surfaces read the same AccountEvents stream", () =>
  Effect.gen(function* () {
    const admin = yield* BillingAdminApi.clientInProcess;
    const tenant = yield* BillingApi.clientInProcess;
    const subscribed = yield* tenant.Subscribe(account.id, { tier: "free", allowances: free });
    yield* admin.AccountEvents.peek(account.id, { atLeast: subscribed });
    const adminPage = yield* admin.AccountEvents.list(account.id);
    const tenantPage = yield* tenant.AccountEvents.list(account.id);
    expect(adminPage.entries.length).toBeGreaterThan(0);
    expect(tenantPage.entries.length).toBe(adminPage.entries.length);
  }).pipe(run),
);
