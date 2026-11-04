import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import { actionsFor } from "../../src/AdminActions.ts";
import { allowance } from "../../src/Allowance.ts";
import { catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import type { EntitlementsState } from "../../src/Subscription/Entitlements.view.ts";
import { tier } from "../../src/Tier.ts";

const free = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });
const pro = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2_000 })],
});
const scale = tier({
  id: "scale",
  price: { amount: 9_900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 5_000 })],
});
const euro = tier({
  id: "euro",
  price: { amount: 1_900, currency: "eur", interval: "month" },
  grants: [allowance(messages, { included: 2_000 })],
});
const testCatalog = Effect.runSync(
  catalog({ features: [messages], tiers: [free, pro, scale, euro] }),
);

const state = (
  status: "trialing" | "active" | "grace" | "canceled" | "expired",
  overrides: { readonly cancelAtPeriodEnd?: boolean; readonly tier?: string } = {},
) => ({
  status,
  tier: overrides.tier ?? "pro",
  currency: "usd" as string | undefined,
  cancelAtPeriodEnd: overrides.cancelAtPeriodEnd ?? false,
});

const actions = (
  status: "trialing" | "active" | "grace" | "canceled" | "expired",
  overrides: { readonly cancelAtPeriodEnd?: boolean; readonly tier?: string } = {},
  options: Parameters<typeof actionsFor>[1] = { catalog: testCatalog },
) => actionsFor(state(status, overrides), options).map((descriptor) => descriptor.action);

const entitlements = (used: number): EntitlementsState =>
  ({
    account: "acct_1",
    tier: "pro",
    status: "active",
    standing: "good",
    periodStart: 0,
    periodEnd: 0,
    cancelAtPeriodEnd: false,
    credits: 0,
    features: {
      messages: {
        included: 2_000,
        used,
        reserved: 0,
        remaining: 2_000 - used,
        allowed: true,
        overage: "block",
        resets: "month",
        resetsAt: null,
      },
    },
  }) as unknown as EntitlementsState;

describe("admin actions", () => {
  it("offers the trial actions only while trialing", () => {
    expect(actions("trialing")).toContain("ExtendTrial");
    expect(actions("active")).not.toContain("ExtendTrial");
    expect(actions("grace")).not.toContain("ExtendTrial");
  });

  it("offers recovery, expiry and a payment only in grace", () => {
    expect(actions("grace")).toEqual(
      expect.arrayContaining(["RecordPayment", "Recover", "Expire"]),
    );
    expect(actions("active")).not.toContain("Recover");
    expect(actions("active")).not.toContain("Expire");
  });

  it("swaps cancellation and resume on the flag, never both", () => {
    const scheduled = actions("active", { cancelAtPeriodEnd: true });
    expect(scheduled).toContain("Resume");
    expect(scheduled).not.toContain("ScheduleCancellation");

    const running = actions("active");
    expect(running).toContain("ScheduleCancellation");
    expect(running).not.toContain("Resume");
  });

  it("offers no action once a standing is over", () => {
    expect(actions("canceled")).toEqual([]);
    expect(actions("expired")).toEqual([]);
  });

  it("offers ChangeTier only with another compatible tier", () => {
    const descriptor = actionsFor(state("active"), { catalog: testCatalog }).find(
      (candidate) => candidate.action === "ChangeTier",
    );
    expect(descriptor?.tiers).toEqual(["free", "scale"]);
  });

  it("does not offer ChangeTier when the account usage exceeds every other tier", () => {
    const descriptor = actionsFor(state("active"), {
      catalog: testCatalog,
      entitlements: entitlements(4_500),
    }).find((candidate) => candidate.action === "ChangeTier");
    // `free` grants 100 and `scale` grants 5,000; 4,500 fits scale but not free.
    expect(descriptor?.tiers).toEqual(["scale"]);
  });

  it("does not offer ChangeTier when there is no other tier", () => {
    const only = Effect.runSync(catalog({ features: [messages], tiers: [pro] }));
    expect(actions("active", { tier: "pro" }, { catalog: only })).not.toContain("ChangeTier");
  });
});
