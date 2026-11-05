import { expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Paykit from "../src/index.ts";

it("exports the four groups from the package root", () => {
  // deploy-time
  expect(typeof Paykit.Stack).toBe("function");
  expect(typeof Paykit.tier).toBe("function");
  expect(typeof Paykit.feature).toBe("function");
  expect(typeof Paykit.allowance).toBe("function");
  expect(typeof Paykit.catalog).toBe("function");
  expect(typeof Paykit.defineCatalog).toBe("function");
  expect(typeof Paykit.allowancesOf).toBe("function");
  expect(typeof Paykit.featureOf).toBe("function");
  expect(Paykit.FeatureId).toBeDefined();
  expect(Paykit.TierId).toBeDefined();
  expect(Paykit.CatalogError).toBeDefined();
  expect(Paykit.messages.id).toBe("messages");
  expect(Paykit.MemoryStore()._tag).toBe("MemoryStore");
  expect(typeof Paykit.migrate).toBe("function");
  expect(typeof Paykit.migrateDryRun).toBe("function");
  expect(typeof Paykit.readMigrationFiles).toBe("function");
  expect(typeof Paykit.SqlEventLog).toBe("function");
  expect(Paykit.MigrationError).toBeDefined();
  expect(Paykit.MigrationHistoryConflictError).toBeDefined();
  expect(Paykit.RewrittenMigrationHistoryError).toBeDefined();
  // runtime
  expect(typeof Paykit.Check).toBe("function");
  expect(typeof Paykit.Track).toBe("function");
  expect(typeof Paykit.Subscribe).toBe("function");
  expect(typeof Paykit.Portal).toBe("function");
  // model
  expect(Paykit.Model.modelName).toBe("Paykit");
  expect(Paykit.BillingAdminApi.name).toContain("BillingAdminApi");
  // the four groups as one namespace
  expect(Paykit.Paykit.feature).toBe(Paykit.feature);
  expect(Paykit.Paykit.Model).toBe(Paykit.Model);
  expect(typeof Paykit.Paykit.providers).toBe("function");
  expect(typeof Paykit.autoTopUp).toBe("function");
  expect(Paykit.Paykit.autoTopUp).toBe(Paykit.autoTopUp);
  expect(typeof Paykit.crossedThreshold).toBe("function");
  expect(Paykit.AutoTopUp).toBeDefined();
  expect(Paykit.AutoTopUpInvalid).toBeDefined();
  expect(typeof Paykit.reconcileBillingStack).toBe("function");
  expect(typeof Paykit.allowsOne).toBe("function");
  expect(Paykit.ProrationMismatch).toBeDefined();
  // a top-up is a policy over a crossing, and its invoice is on the event
  expect(typeof Paykit.topUpCommandId).toBe("function");
  expect(Paykit.CreditsPurchased).toBeDefined();
  expect(typeof Paykit.Paykit.CatalogGuard).toBe("object");
  // preview, verify and list are runtime bindings
  expect(typeof Paykit.Preview).toBe("function");
  expect(typeof Paykit.Verify).toBe("function");
  expect(typeof Paykit.List).toBe("function");
  expect(typeof Paykit.Hold).toBe("function");
  expect(typeof Paykit.Settle).toBe("function");
  expect(typeof Paykit.Release).toBe("function");
  // auth primitives
  expect(Paykit.Actor).toBeDefined();
  expect(Paykit.Session).toBeDefined();
  expect(Paykit.Admin).toBeDefined();
  expect(Paykit.Forbidden).toBeDefined();
  expect(Paykit.Unauthenticated).toBeDefined();
  expect(Paykit.CatalogMismatch).toBeDefined();
  expect(Paykit.mayActOn({ kind: "account", id: "a" }, "a")).toBe(true);
  expect(Paykit.mayActOn({ kind: "account", id: "a" }, "b")).toBe(false);
  expect(Paykit.mayActOn({ kind: "admin", id: "ops" }, "b")).toBe(true);
  // the money events carry what was charged
  expect(Paykit.SubscriptionActivated).toBeDefined();
  expect(Paykit.TierChanged).toBeDefined();
  // providers
  expect(Paykit.Memory().kind).toBe("memory");
  expect(Paykit.Manual().kind).toBe("manual");
});

it.effect("a catalog built through the public helpers is the same one Stack validates", () =>
  Effect.gen(function* () {
    const free = Paykit.tier({
      id: "free",
      grants: [Paykit.allowance(Paykit.messages, { included: 100 })],
    });
    const pro = Paykit.tier({
      id: "pro",
      price: { amount: 1900, currency: "usd", interval: "month" },
      grants: [Paykit.allowance(Paykit.messages, { included: 2000, overage: "bill" })],
    });
    const billing = yield* Paykit.Stack("Billing", {
      catalog: { features: [Paykit.messages], tiers: [free, pro] },
      providers: [Paykit.Memory()],
    });
    expect(billing.catalog.features.map((feature) => feature.id)).toEqual(["messages"]);
    expect(billing.catalog.tiers.map((tier) => tier.id)).toEqual(["free", "pro"]);
    expect(billing.providers[0]?.kind).toBe("memory");
  }),
);

it("vocabulary is exported as API", () => {
  expect(Paykit.SubscriptionStatus.literals).toEqual([
    "trialing",
    "active",
    "grace",
    "canceled",
    "expired",
  ]);
  expect(Paykit.Standing.literals).toEqual(["good", "grace", "blocked"]);
});
