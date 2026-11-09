import * as Domain from "@alchemy.run/domain";
import { expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { allowance } from "../src/Allowance.ts";
import { InsecureDevGuards } from "../src/Auth/FromHeaders.ts";
import { BillingAdminApi } from "../src/BillingAdminApi.api.ts";
import { BillingApi } from "../src/BillingApi.api.ts";
import { MemoryBillingReadStore } from "../src/BillingReadStore.ts";
import { planItemsOf, catalog } from "../src/Catalog.ts";
import { CatalogGuardLive } from "../src/CatalogGuard.ts";
import { catalogLayer } from "../src/CatalogService.ts";
import { messages } from "../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../src/Paykit.model.ts";
import { Subscription } from "../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../src/Tier.ts";

const freeTier = tier({
  id: "free",
  grants: [allowance(messages, { included: 100 })],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [freeTier] }));
const free = planItemsOf(testCatalog, "free")!;
const account = Subscription.ref("acct_api");

// The guards and the catalog a guarded command is checked against.
const World = PaykitModel.layer(PaykitHandlers)
  .pipe(Layer.provideMerge(MemoryBillingReadStore))
  .pipe(Layer.provide(Domain.InMemory))
  .pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        InsecureDevGuards,
        CatalogGuardLive.pipe(Layer.provideMerge(catalogLayer(testCatalog))),
      ),
    ),
  );

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(World));

/** Headers a signed-in account sends: it acts for itself. */
const asAccount = { headers: { "x-paykit-actor": account.id } };

/** Headers an operator sends: it may act for any account. */
const asAdmin = { headers: { "x-paykit-actor": "ops_1", "x-paykit-kind": "admin" } };

it.live("an admin grants credits through the command, then reads Entitlements", () =>
  Effect.gen(function* () {
    const admin = yield* BillingAdminApi.clientInProcess;
    const tenant = yield* BillingApi.clientInProcess;
    yield* tenant.Subscribe(
      account.id,
      { tier: "free", allowances: free, credits: 0, creditsExpire: "period", rates: {} },
      asAccount,
    );
    const granted = yield* admin.GrantCredits(account.id, { amount: 250 }, asAdmin);
    expect(granted.reply).toEqual({ balance: 250 });
    const state = yield* admin.BillingState.get(account.id, { atLeast: granted, ...asAdmin });
    expect(state?.credits).toBe(250);

    const entitlements = yield* admin.Entitlements.get(account.id, {
      atLeast: granted,
      ...asAdmin,
    });

    expect(entitlements?.tier).toBe("free");
    expect(entitlements?.standing).toBe("good");

    // Raw aggregate state is guarded too: an account cannot read another's.
    const refusedRaw = yield* Effect.exit(
      admin.Subscription.get(Subscription.ref("acct_someone_else").id, asAdmin),
    );

    expect(refusedRaw._tag).toBe("Success");
    const whole = yield* admin.Subscription.get(account.id, asAdmin);
    expect(whole?._tag).toBe("Subscribed");

    if (whole?._tag === "Subscribed") expect(whole.credits).toBe(250);
  }).pipe(run),
);

it.live("the tenant surface tracks usage but does not serve the admin commands", () =>
  Effect.gen(function* () {
    const tenant = yield* BillingApi.clientInProcess;
    yield* tenant.Subscribe(
      account.id,
      { tier: "free", allowances: free, credits: 0, creditsExpire: "period", rates: {} },
      asAccount,
    );

    const tracked = yield* tenant.TrackUsage(
      account.id,
      { feature: "messages", amount: 5 },
      asAccount,
    );

    expect(tracked.stream).toContain("Subscription/");
    expect("GrantCredits" in tenant).toBe(false);
    expect("ChangeTier" in tenant).toBe(true);
  }).pipe(run),
);

it.live("a request with no caller is refused before it reaches the model", () =>
  Effect.gen(function* () {
    const tenant = yield* BillingApi.clientInProcess;

    const exit = yield* Effect.exit(
      tenant.Subscribe(account.id, {
        tier: "free",
        allowances: free,
        credits: 0,
        creditsExpire: "period",
        rates: {},
      }),
    );

    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("Unauthenticated");
  }).pipe(run),
);

it.live("an account cannot act on another account", () =>
  Effect.gen(function* () {
    const tenant = yield* BillingApi.clientInProcess;

    const exit = yield* Effect.exit(
      tenant.Subscribe(
        Subscription.ref("acct_someone_else").id,
        { tier: "free", allowances: free, credits: 0, creditsExpire: "period", rates: {} },
        asAccount,
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("Forbidden");
  }).pipe(run),
);

it.live("an account cannot reach an operator command", () =>
  Effect.gen(function* () {
    const admin = yield* BillingAdminApi.clientInProcess;
    const exit = yield* Effect.exit(admin.GrantCredits(account.id, { amount: 250 }, asAccount));
    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("Forbidden");
  }).pipe(run),
);

it.live("a signed-in account reads only its own entitlements", () =>
  Effect.gen(function* () {
    const admin = yield* BillingAdminApi.clientInProcess;
    const tenant = yield* BillingApi.clientInProcess;

    const subscribed = yield* tenant.Subscribe(
      account.id,
      { tier: "free", allowances: free, credits: 0, creditsExpire: "period", rates: {} },
      asAccount,
    );

    const mine = yield* tenant.Entitlements.get(account.id, { atLeast: subscribed, ...asAccount });
    expect(mine?.account).toBe(account.id);

    const theirs = yield* Effect.exit(
      tenant.Entitlements.get(Subscription.ref("acct_someone_else").id, asAccount),
    );

    expect(theirs._tag).toBe("Failure");
    // An operator reads any account through the same view.
    const any = yield* admin.Entitlements.get(Subscription.ref("acct_someone_else").id, asAdmin);
    expect(any).toBeNull();
  }).pipe(run),
);

it.live("both surfaces read the same AccountEvents stream", () =>
  Effect.gen(function* () {
    const admin = yield* BillingAdminApi.clientInProcess;
    const tenant = yield* BillingApi.clientInProcess;

    const subscribed = yield* tenant.Subscribe(
      account.id,
      { tier: "free", allowances: free, credits: 0, creditsExpire: "period", rates: {} },
      asAccount,
    );

    yield* admin.AccountEvents.peek(account.id, { atLeast: subscribed, ...asAdmin });
    const adminPage = yield* admin.AccountEvents.list(account.id, asAdmin);
    const tenantPage = yield* tenant.AccountEvents.list(account.id, asAccount);
    expect(adminPage.entries.length).toBeGreaterThan(0);
    expect(tenantPage.entries.length).toBe(adminPage.entries.length);
  }).pipe(run),
);

it.live("refuses a forged controls feature map with CatalogMismatch", () =>
  Effect.gen(function* () {
    const tenant = yield* BillingApi.clientInProcess;
    yield* tenant.Subscribe(
      account.id,
      { tier: "free", allowances: free, credits: 0, creditsExpire: "period", rates: {} },
      asAccount,
    );

    // `messages` has no unit price, so the catalog says `unpriced`; a caller
    // that claims otherwise is refused before `decide` sees it.
    const refused = yield* Effect.flip(
      tenant.SetBillingControls(
        account.id,
        {
          billingControls: { spendLimits: [{ featureId: "messages", amount: 10 }] },
          features: { messages: { priced: true } },
        },
        asAccount,
      ),
    );

    expect(refused._tag).toBe("CatalogMismatch");
  }).pipe(run),
);
