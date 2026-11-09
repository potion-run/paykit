import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { allowance, grant } from "../../src/Allowance.ts";
import { catalog, planTermsOf } from "../../src/Catalog.ts";
import { feature, messages } from "../../src/Feature.ts";
import { CancelImmediately } from "../../src/Subscription/CancelImmediately.command.ts";
import { ChangeTier } from "../../src/Subscription/ChangeTier.command.ts";
import { ClosePeriod } from "../../src/Subscription/ClosePeriod.command.ts";
import { BalanceExpired, ExpireGrant } from "../../src/Subscription/ExpireGrant.command.ts";
import { BalanceGranted, GrantBalance } from "../../src/Subscription/GrantBalance.command.ts";
import { Hold } from "../../src/Subscription/Hold.command.ts";
import { ReleaseHold } from "../../src/Subscription/ReleaseHold.command.ts";
import { SettleHold } from "../../src/Subscription/SettleHold.command.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { grantTotalOf, grantsOf } from "../../src/Subscription/Subscription.state.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { decideAt, evolveAt, isAccepted, start, subscribedIn } from "./Arbitraries.ts";

const ai = feature({ id: "ai", name: "AI", creditRates: { default: 1 } });
const seats = feature({ id: "seats", name: "Seats", kind: "non_consumable" });
const sso = feature({ id: "sso", name: "SSO", kind: "flag" });
const unlimited = feature({ id: "unlimited", name: "Unlimited" });
const extra = feature({ id: "extra", name: "Extra" });

const grantCatalog = Effect.runSync(
  catalog({
    features: [messages, ai, seats, sso, unlimited, extra],
    tiers: [
      tier({
        id: "free",
        grants: [
          allowance(messages, { included: 10 }),
          allowance(seats, { included: 2, overage: "allow" }),
          grant(sso),
          allowance(unlimited, { included: "unlimited" }),
        ],
      }),
      tier({
        id: "pro",
        grants: [allowance(messages, { included: 100 })],
      }),
    ],
  }),
);

const tagOf = (decision: unknown): string | undefined =>
  Array.isArray(decision) ? undefined : (decision as { readonly _tag?: string } | null)?._tag;

const eventOf = <T extends { readonly _tag: string }>(
  decision: ReadonlyArray<T>,
  tag: string,
): T | undefined => decision.find((event) => event._tag === tag);

describe("standalone grants", () => {
  it("adds a lifetime grant, and the plan is spent first", () => {
    const opened = subscribedIn(grantCatalog, "free");

    const granted = decideAt(
      opened,
      new GrantBalance({ feature: "messages", granted: 5 }),
      start,
      "grant:1",
    );

    expect(isAccepted(granted)).toBe(true);

    if (!isAccepted(granted)) throw new Error("expected a grant");

    const event = eventOf(granted, "BalanceGranted") as BalanceGranted | undefined;

    expect(event?.grantId).toBe("grant:1");
    expect(event?.remainingAfter).toBe(15);

    const afterGrant = evolveAt(opened, granted, start, "grant:1");

    if (afterGrant._tag !== "Subscribed") throw new Error("expected a standing");

    expect(afterGrant.grants?.["grant:1"]?.remaining).toBe(5);
    expect(afterGrant.remaining.messages).toBe(15);
    expect(grantTotalOf(afterGrant, "messages")).toBe(5);

    // Twelve units: ten from the plan, then two from the grant.
    const spend = decideAt(
      afterGrant,
      new TrackUsage({ feature: "messages", amount: 12 }),
      start,
      "use",
    );

    expect(isAccepted(spend)).toBe(true);

    if (!isAccepted(spend)) throw new Error("expected usage");

    const recorded = eventOf(spend, "UsageRecorded") as
      | { readonly grantsUsed?: Record<string, number>; readonly remainingAfter: number }
      | undefined;

    expect(recorded?.grantsUsed).toEqual({ "grant:1": 2 });
    expect(recorded?.remainingAfter).toBe(3);

    const afterSpend = evolveAt(afterGrant, spend, start, "use");

    if (afterSpend._tag !== "Subscribed") throw new Error("expected a standing");

    expect(afterSpend.remaining.messages).toBe(3);
    expect(afterSpend.grants?.["grant:1"]?.remaining).toBe(3);
  });

  it("a grant survives a period close and a plan change", () => {
    const opened = subscribedIn(grantCatalog, "free");

    const granted = decideAt(
      opened,
      new GrantBalance({ feature: "messages", granted: 5 }),
      start,
      "grant:1",
    );

    if (!isAccepted(granted)) throw new Error("expected a grant");
    const withGrantValue = evolveAt(opened, granted, start, "grant:1");

    if (withGrantValue._tag !== "Subscribed") throw new Error("expected a standing");

    const closed = decideAt(
      withGrantValue,
      new ClosePeriod({ periodEnd: withGrantValue.period.end }),
      withGrantValue.period.end,
      "close",
    );

    expect(isAccepted(closed)).toBe(true);

    if (!isAccepted(closed)) throw new Error("expected a close");

    const reset = eventOf(closed, "UsageReset") as
      | { readonly remaining: Record<string, number | null> }
      | undefined;

    expect(reset?.remaining.messages).toBe(15);

    const afterClose = evolveAt(withGrantValue, closed, withGrantValue.period.end, "close");

    if (afterClose._tag !== "Subscribed") throw new Error("expected a standing");

    expect(afterClose.grants?.["grant:1"]?.remaining).toBe(5);
    expect(afterClose.remaining.messages).toBe(15);

    const terms = planTermsOf(grantCatalog, "pro");

    if (terms === null) throw new Error("the catalog is missing pro");

    const changed = decideAt(
      afterClose,
      new ChangeTier({ tier: "pro", ...terms }),
      afterClose.period.start,
      "change",
    );

    expect(isAccepted(changed)).toBe(true);

    if (!isAccepted(changed)) throw new Error("expected a change");

    const afterChange = evolveAt(afterClose, changed, afterClose.period.start, "change");

    if (afterChange._tag !== "Subscribed") throw new Error("expected a standing");

    expect(afterChange.grants?.["grant:1"]?.remaining).toBe(5);
    expect(afterChange.remaining.messages).toBe(105);
  });

  it("a lifetime grant survives a cancellation and a new activation", () => {
    const opened = subscribedIn(grantCatalog, "free");

    const granted = decideAt(
      opened,
      new GrantBalance({ feature: "messages", granted: 5 }),
      start,
      "grant:1",
    );

    if (!isAccepted(granted)) throw new Error("expected a grant");
    const withGrantValue = evolveAt(opened, granted, start, "grant:1");

    if (withGrantValue._tag !== "Subscribed") throw new Error("expected a standing");

    const canceled = decideAt(withGrantValue, new CancelImmediately({}), start, "cancel");

    expect(isAccepted(canceled)).toBe(true);

    if (!isAccepted(canceled)) throw new Error("expected a cancellation");

    const afterCancel = evolveAt(withGrantValue, canceled, start, "cancel");

    if (afterCancel._tag !== "Subscribed") throw new Error("expected a standing");

    expect(afterCancel.grants?.["grant:1"]?.remaining).toBe(5);

    const terms = planTermsOf(grantCatalog, "free");

    if (terms === null) throw new Error("the catalog is missing free");

    const reactivated = decideAt(
      afterCancel,
      new Subscribe({ tier: "free", ...terms }),
      start,
      "reactivate",
    );

    expect(isAccepted(reactivated)).toBe(true);

    if (!isAccepted(reactivated)) throw new Error("expected a reactivation");

    const afterReactivate = evolveAt(afterCancel, reactivated, start, "reactivate");

    if (afterReactivate._tag !== "Subscribed") throw new Error("expected a standing");

    expect(afterReactivate.grants?.["grant:1"]?.remaining).toBe(5);
    expect(afterReactivate.remaining.messages).toBe(15);
  });

  it("a hold takes the grant only after the plan, and returns the unused part", () => {
    const opened = subscribedIn(grantCatalog, "free");

    const granted = decideAt(
      opened,
      new GrantBalance({ feature: "messages", granted: 5 }),
      start,
      "grant:1",
    );

    if (!isAccepted(granted)) throw new Error("expected a grant");
    const state = evolveAt(opened, granted, start, "grant:1");

    if (state._tag !== "Subscribed") throw new Error("expected a standing");

    const held = decideAt(
      state,
      new Hold({
        holdId: "hold_1",
        feature: "messages",
        amount: 12,
        expiresAt: DateTime.add(start, { days: 1 }),
      }),
      start,
      "hold",
    );

    expect(isAccepted(held)).toBe(true);

    if (!isAccepted(held)) throw new Error("expected a hold");

    const reserved = eventOf(held, "UsageReserved") as
      | { readonly grantsUsed?: Record<string, number> }
      | undefined;

    expect(reserved?.grantsUsed).toEqual({ "grant:1": 2 });

    const afterHold = evolveAt(state, held, start, "hold");

    if (afterHold._tag !== "Subscribed") throw new Error("expected a standing");

    expect(afterHold.remaining.messages).toBe(3);
    expect(afterHold.grants?.["grant:1"]?.remaining).toBe(3);

    // Ten ran, two return. The plan paid for the ten; the grant comes back.
    const settled = decideAt(
      afterHold,
      new SettleHold({ holdId: "hold_1", amount: 10 }),
      start,
      "settle",
    );

    expect(isAccepted(settled)).toBe(true);

    if (!isAccepted(settled)) throw new Error("expected a settle");

    const afterSettle = evolveAt(afterHold, settled, start, "settle");

    if (afterSettle._tag !== "Subscribed") throw new Error("expected a standing");

    expect(afterSettle.remaining.messages).toBe(5);
    expect(afterSettle.grants?.["grant:1"]?.remaining).toBe(5);
  });

  it("releases a hold's grant units", () => {
    const opened = subscribedIn(grantCatalog, "free");

    const granted = decideAt(
      opened,
      new GrantBalance({ feature: "messages", granted: 5 }),
      start,
      "grant:1",
    );

    if (!isAccepted(granted)) throw new Error("expected a grant");
    const state = evolveAt(opened, granted, start, "grant:1");

    if (state._tag !== "Subscribed") throw new Error("expected a standing");

    const held = decideAt(
      state,
      new Hold({
        holdId: "hold_1",
        feature: "messages",
        amount: 12,
        expiresAt: DateTime.add(start, { days: 1 }),
      }),
      start,
      "hold",
    );

    if (!isAccepted(held)) throw new Error("expected a hold");
    const afterHold = evolveAt(state, held, start, "hold");

    if (afterHold._tag !== "Subscribed") throw new Error("expected a standing");

    const released = decideAt(afterHold, new ReleaseHold({ holdId: "hold_1" }), start, "release");

    expect(isAccepted(released)).toBe(true);

    if (!isAccepted(released)) throw new Error("expected a release");

    const afterRelease = evolveAt(afterHold, released, start, "release");

    if (afterRelease._tag !== "Subscribed") throw new Error("expected a standing");

    expect(afterRelease.remaining.messages).toBe(15);
    expect(afterRelease.grants?.["grant:1"]?.remaining).toBe(5);
    expect(grantsOf(afterRelease, "messages")).toHaveLength(1);
  });

  it("a grant can be the only source for a feature the plan does not grant", () => {
    const opened = subscribedIn(grantCatalog, "free");

    const granted = decideAt(
      opened,
      new GrantBalance({ feature: "extra", granted: 5 }),
      start,
      "grant:extra",
    );

    expect(isAccepted(granted)).toBe(true);

    if (!isAccepted(granted)) throw new Error("expected a grant");

    const state = evolveAt(opened, granted, start, "grant:extra");

    if (state._tag !== "Subscribed") throw new Error("expected a standing");

    expect(state.remaining.extra).toBe(5);
    expect(state.grants?.["grant:extra"]?.remaining).toBe(5);

    const spend = decideAt(
      state,
      new TrackUsage({ feature: "extra", amount: 2 }),
      start,
      "use:extra",
    );

    expect(isAccepted(spend)).toBe(true);

    if (!isAccepted(spend)) throw new Error("expected usage");

    const afterSpend = evolveAt(state, spend, start, "use:extra");

    if (afterSpend._tag !== "Subscribed") throw new Error("expected a standing");

    expect(afterSpend.remaining.extra).toBe(3);
    expect(afterSpend.grants?.["grant:extra"]?.remaining).toBe(3);

    // The grant belongs to the customer, so a plan boundary resets usage but
    // keeps the source and its remaining units.
    const closed = decideAt(
      afterSpend,
      new ClosePeriod({ periodEnd: afterSpend.period.end }),
      afterSpend.period.end,
      "close:extra",
    );

    expect(isAccepted(closed)).toBe(true);

    if (!isAccepted(closed)) throw new Error("expected a close");

    const afterClose = evolveAt(afterSpend, closed, afterSpend.period.end, "close:extra");

    if (afterClose._tag !== "Subscribed") throw new Error("expected a standing");

    expect(afterClose.remaining.extra).toBe(3);
    expect(afterClose.grants?.["grant:extra"]?.remaining).toBe(3);

    // The new plan does not grant `extra`; the lifetime grant keeps it alive.
    const terms = planTermsOf(grantCatalog, "pro");

    if (terms === null) throw new Error("the catalog is missing pro");

    const changed = decideAt(
      afterClose,
      new ChangeTier({ tier: "pro", ...terms }),
      afterClose.period.start,
      "change:extra",
    );

    expect(isAccepted(changed)).toBe(true);

    if (!isAccepted(changed)) throw new Error("expected a change");

    const afterChange = evolveAt(afterClose, changed, afterClose.period.start, "change:extra");

    if (afterChange._tag !== "Subscribed") throw new Error("expected a standing");

    expect(afterChange.remaining.extra).toBe(3);
    expect(afterChange.grants?.["grant:extra"]?.remaining).toBe(3);
  });

  it("expires an expiring grant at its deadline, and leaves a lifetime one", () => {
    const opened = subscribedIn(grantCatalog, "free");

    const expiring = decideAt(
      opened,
      new GrantBalance({
        feature: "messages",
        granted: 5,
        expiresAt: DateTime.add(start, { days: 1 }),
      }),
      start,
      "grant:expiring",
    );

    if (!isAccepted(expiring)) throw new Error("expected a grant");
    const state = evolveAt(opened, expiring, start, "grant:expiring");

    if (state._tag !== "Subscribed") throw new Error("expected a standing");

    const expired = decideAt(
      state,
      new ExpireGrant({ feature: "messages", grantId: "grant:expiring" }),
      DateTime.add(start, { days: 2 }),
      "expire",
    );

    expect(isAccepted(expired)).toBe(true);

    if (!isAccepted(expired)) throw new Error("expected an expiry");

    const event = eventOf(expired, "BalanceExpired") as BalanceExpired | undefined;

    expect(event?.amount).toBe(5);
    expect(event?.balanceAfter).toBe(10);

    const afterExpiry = evolveAt(state, expired, DateTime.add(start, { days: 2 }), "expire");

    if (afterExpiry._tag !== "Subscribed") throw new Error("expected a standing");

    expect(afterExpiry.grants?.["grant:expiring"]).toBeUndefined();
    expect(afterExpiry.remaining.messages).toBe(10);
  });

  it("refuses a grant a customer cannot hold", () => {
    const opened = subscribedIn(grantCatalog, "free");

    expect(
      tagOf(decideAt(opened, new GrantBalance({ feature: "ai", granted: 1 }), start, "credit")),
    ).toBe("FeaturePricedInCredits");
    expect(
      tagOf(decideAt(opened, new GrantBalance({ feature: "seats", granted: 1 }), start, "seat")),
    ).toBe("FeatureNotConsumable");
    expect(
      tagOf(decideAt(opened, new GrantBalance({ feature: "sso", granted: 1 }), start, "flag")),
    ).toBe("FeatureNotMetered");
    expect(
      tagOf(decideAt(opened, new GrantBalance({ feature: "unlimited", granted: 1 }), start, "inf")),
    ).toBe("FeatureNotCounted");
  });
});
