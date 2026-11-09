import { describe, expect, it } from "@alchemy.run/test";
import { balanceOfFeature } from "../../src/Balance.ts";
import { evaluateCheck } from "../../src/Check.ts";
import { BillingControls, controlsKey, normalizeBillingControls } from "../../src/Customer.ts";
import {
  alertThresholdsOf,
  effectiveTopUpOf,
  topUpOf,
} from "../../src/Subscription/Subscription.state.ts";

const usd = { _tag: "unit" as const, unitPrice: { amount: 2, currency: "usd" } };

describe("the controls object has one representation", () => {
  it("sorts limits by feature and alerts by (feature, at)", () => {
    const controls: BillingControls = {
      spendLimits: [
        { featureId: "storage", amount: 2 },
        { featureId: "requests", amount: 1 },
      ],
      usageAlerts: [
        { featureId: "requests", at: 20 },
        { featureId: "requests", at: 10 },
        { featureId: "storage", at: 5 },
      ],
    };

    expect(normalizeBillingControls(controls)).toEqual({
      spendLimits: [
        { featureId: "requests", amount: 1 },
        { featureId: "storage", amount: 2 },
      ],
      usageAlerts: [
        { featureId: "requests", at: 10 },
        { featureId: "requests", at: 20 },
        { featureId: "storage", at: 5 },
      ],
    });
  });

  it("collapses empty arrays and an empty object", () => {
    expect(normalizeBillingControls({})).toBeUndefined();
    expect(normalizeBillingControls({ spendLimits: [] })).toBeUndefined();
    expect(normalizeBillingControls(undefined)).toBeUndefined();
  });

  it("keys two callers' orders the same, so the second write is a no-op", () => {
    const left: BillingControls = {
      spendLimits: [
        { featureId: "a", amount: 1 },
        { featureId: "b", amount: 2 },
      ],
    };

    const right: BillingControls = {
      spendLimits: [
        { featureId: "b", amount: 2 },
        { featureId: "a", amount: 1 },
      ],
    };

    expect(controlsKey(left)).toBe(controlsKey(right));
  });

  it("is stable against the key order of the auto top-up object", () => {
    expect(controlsKey({ autoTopUp: { threshold: 500, enabled: true } })).toBe(
      controlsKey({ autoTopUp: { enabled: true, threshold: 500 } }),
    );
  });
});

describe("the effective auto top-up line", () => {
  const line = { threshold: 5_000, pack: "credits_100k" };

  it("is the plan's when the customer states no override", () => {
    expect(effectiveTopUpOf(line, undefined)).toEqual(line);
    expect(effectiveTopUpOf(line, {})).toEqual(line);
  });

  it("takes the customer's threshold and keeps the plan's pack", () => {
    expect(effectiveTopUpOf(line, { autoTopUp: { enabled: true, threshold: 2_000 } })).toEqual({
      threshold: 2_000,
      pack: "credits_100k",
    });
  });

  it("is off when the customer disables it, even over a plan line", () => {
    expect(effectiveTopUpOf(line, { autoTopUp: { enabled: false } })).toBeNull();
  });

  it("uses the plan's threshold when the override states none", () => {
    expect(effectiveTopUpOf(line, { autoTopUp: { enabled: true } })).toEqual(line);
  });

  it("brings a line to a plan that has none, when a threshold is stated", () => {
    expect(effectiveTopUpOf(undefined, { autoTopUp: { enabled: true, threshold: 2_000 } })).toEqual(
      { threshold: 2_000 },
    );
  });

  it("has no line when neither side states a threshold", () => {
    expect(effectiveTopUpOf(undefined, { autoTopUp: { enabled: true } })).toBeNull();
  });

  it("reaches a standing, never a customer with no plan", () => {
    // A control is customer intent, but a line needs a standing to carry it.
    expect(
      topUpOf({
        _tag: "Unsubscribed",
        refs: {},
        billingControls: { autoTopUp: { enabled: true, threshold: 400 } },
      } as never),
    ).toBeNull();
  });
});

describe("the spend ceiling on a balance", () => {
  const feature = {
    overage: "bill" as const,
    included: 0,
    remaining: 1_000,
    resetsAt: null,
    pricing: usd,
    billed: 4,
    used: 2,
    spendLimit: 10,
  };

  it("reports the headroom as money, not units", () => {
    const balance = balanceOfFeature("acct", "requests", feature);

    expect(balance.spendLimit).toEqual({ amount: 10, remaining: 6 });
  });

  it("reports no headroom once the ceiling is lowered under the bill", () => {
    const balance = balanceOfFeature("acct", "requests", { ...feature, spendLimit: 3 });

    expect(balance.spendLimit).toEqual({ amount: 3, remaining: 0 });
  });

  it("answers `check` with the limit the write path enforces", () => {
    const state = {
      standing: "good" as const,
      features: { requests: feature },
    };

    // One more unit costs 2: billed 4 + 2 is under the 10 ceiling.
    expect(evaluateCheck(state, { account: "acct", featureId: "requests" }).allowed).toBe(true);

    // Four more cost 8: 4 + 8 > 10, so the check refuses while the balance
    // reports the remaining headroom.
    const past = evaluateCheck(state, {
      account: "acct",
      featureId: "requests",
      requiredBalance: 4,
    });

    expect(past.allowed).toBe(false);
    expect(past.balance.spendLimit).toEqual({ amount: 10, remaining: 6 });
  });
});

describe("alert thresholds", () => {
  it("are read in ascending order for one feature", () => {
    const state = {
      _tag: "Subscribed" as const,
      billingControls: {
        usageAlerts: [
          { featureId: "requests", at: 20 },
          { featureId: "requests", at: 10 },
          { featureId: "storage", at: 1 },
        ],
      },
    };

    expect(alertThresholdsOf(state as never, "requests")).toEqual([10, 20]);
  });
});
