import { expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Paykit from "../src/index.ts";

it("exports the four groups from the package root", () => {
  // deploy-time
  expect(typeof Paykit.BillingStack).toBe("function");
  expect(typeof Paykit.validateStack).toBe("function");
  expect(typeof Paykit.world).toBe("function");
  expect("paykitWorld" in Paykit).toBe(false);
  expect(typeof Paykit.tier).toBe("function");
  expect(typeof Paykit.feature).toBe("function");
  expect(typeof Paykit.allowance).toBe("function");
  expect(typeof Paykit.catalog).toBe("function");
  expect(typeof Paykit.defineCatalog).toBe("function");
  expect(typeof Paykit.allowancesOf).toBe("function");
  expect(typeof Paykit.featureOf).toBe("function");
  expect(Paykit.FeatureId).toBeDefined();
  expect(Paykit.TierId).toBeDefined();
  expect(Paykit.TopUpThreshold).toBeDefined();
  expect(Paykit.CatalogTopUpOnPack).toBeDefined();
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
  // runtime — the binding surface, under its own namespace
  const Billing = Paykit.Billing;
  expect(Billing.TrackUsage.key).toBe("Paykit.TrackUsage");
  expect(Billing.SettleHold.key).toBe("Paykit.SettleHold");
  expect(Billing.ChangeTier.key).toBe("Paykit.ChangeTier");
  expect(Billing.GrantCredits.key).toBe("Paykit.GrantCredits");
  expect(Billing.BillingInProcess).toBeDefined();
  expect(Billing.BillingApiLayer).toBeDefined();
  expect(Billing.BillingAdminInProcess).toBeDefined();
  expect(Billing.BillingAdminApiLayer).toBeDefined();
  expect(Paykit.Paykit.Billing).toBe(Billing);
  // the Effect Atom client is a first-class runtime surface too
  expect(typeof Paykit.Atom.make).toBe("function");
  expect(typeof Paykit.Atom.accountReactivityKey).toBe("function");
  // runtime — the retiring names, still flat until the migration slice
  // one binding per command, named for the command — no aliases
  expect(Paykit.Check.key).toBe("Paykit.Check");
  expect(Paykit.TrackUsage.key).toBe("Paykit.TrackUsage");
  expect(Paykit.SettleHold.key).toBe("Paykit.SettleHold");
  expect(Paykit.ReleaseHold.key).toBe("Paykit.ReleaseHold");
  expect(Paykit.ChangeTier.key).toBe("Paykit.ChangeTier");
  expect(Paykit.Subscribe.key).toBe("Paykit.Subscribe");
  expect(Paykit.Portal.key).toBe("Paykit.Portal");
  expect(Paykit.Webhook.key).toBe("Paykit.Webhook");
  // the retiring names are gone: one spelling, not two
  expect((Paykit as Record<string, unknown>).Track).toBeUndefined();
  expect((Paykit as Record<string, unknown>).Settle).toBeUndefined();
  expect((Paykit as Record<string, unknown>).Release).toBeUndefined();
  expect((Paykit as Record<string, unknown>).CheckInProcess).toBeUndefined();
  expect((Paykit as Record<string, unknown>).CheckHttp).toBeUndefined();
  // model
  expect(Paykit.Model.modelName).toBe("Paykit");
  expect(Paykit.BillingAdminApi.name).toContain("BillingAdminApi");
  // the four groups as one namespace
  expect(Paykit.Paykit.feature).toBe(Paykit.feature);
  expect(Paykit.Paykit.Model).toBe(Paykit.Model);
  expect(typeof Paykit.Paykit.providers).toBe("function");
  expect(typeof Paykit.autoTopUp).toBe("function");
  expect(typeof Paykit.dunning).toBe("function");
  expect(Paykit.Paykit.dunning).toBe(Paykit.dunning);
  expect(Paykit.Dunning).toBeDefined();
  expect(Paykit.DunningRetryDue).toBeDefined();
  expect(Paykit.DunningInvalid).toBeDefined();
  expect(typeof Paykit.timelineOf).toBe("function");
  expect(typeof Paykit.appendTimeline).toBe("function");
  expect(typeof Paykit.Paykit.timelineOf).toBe("function");
  expect(Paykit.TimelineEntry).toBeDefined();
  expect(Paykit.UsageTimeline).toBeDefined();
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
  // preview, verify and list are runtime bindings too
  expect(Paykit.Preview.key).toBe("Paykit.Preview");
  expect(typeof Paykit.Verify).toBe("function");
  expect(Paykit.List.key).toBe("Paykit.List");
  expect(Paykit.Hold.key).toBe("Paykit.Hold");
  expect(Paykit.SettleHold.key).toBe("Paykit.SettleHold");
  expect(Paykit.ReleaseHold.key).toBe("Paykit.ReleaseHold");
  // auth primitives
  expect(Paykit.Actor).toBeDefined();
  expect(Paykit.Session).toBeDefined();
  expect(Paykit.Admin).toBeDefined();
  expect(Paykit.Forbidden).toBeDefined();
  expect(Paykit.Unauthenticated).toBeDefined();
  // one resolver per deployment, and the two guards over it
  expect(typeof Paykit.SessionFrom).toBe("function");
  expect(typeof Paykit.AdminFrom).toBe("function");
  expect(typeof Paykit.GuardsFrom).toBe("function");
  expect(typeof Paykit.Paykit.SessionFrom).toBe("function");
  expect(Paykit.Paykit.SessionFrom).toBe(Paykit.SessionFrom);
  expect(Paykit.Paykit.GuardsFrom).toBe(Paykit.GuardsFrom);
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

    const billing = yield* Paykit.validateStack("Billing", {
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
  expect(typeof Paykit.standingPhaseOf).toBe("function");
  expect(typeof Paykit.standingConditionsOf).toBe("function");
  expect(Paykit.StandingPhase).toBeDefined();
  expect(Paykit.isStandingPhaseEdge("Active", "Grace")).toBe(true);
  expect(Paykit.isStandingPhaseEdge("Expired", "Grace")).toBe(false);
  expect(Paykit.nextStandingPhase("Grace", "expire")).toBe("Expired");
  expect(typeof Paykit.standingTransitionOf).toBe("function");
  expect(typeof Paykit.standingPhaseOfView).toBe("function");
  expect(typeof Paykit.standingPhaseTagOfStatus).toBe("function");
  expect(typeof Paykit.webhookActionOf).toBe("function");
  expect(Paykit.WEBHOOK_TRANSITIONS.payment_failed.Expired).toBe("ignored");
  expect(Paykit.nextHoldStatus("open", "expire")).toBe("expired");
});
