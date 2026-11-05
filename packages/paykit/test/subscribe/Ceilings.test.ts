import { describe, expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { messages } from "../../src/Feature.ts";
import {
  ChangeTier,
  DowngradeBelowCeiling,
  DowngradeBelowSpend,
} from "../../src/Subscription/ChangeTier.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import type { SubscribedState } from "../../src/Subscription/Subscription.state.ts";

const at = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const monthLater = DateTime.makeUnsafe("2030-02-01T00:00:00Z");

/**
 * A standing that has already spent this period. The counters are what a tier
 * change keeps: `billed` and `usage` survive because a change is not a period
 * boundary, which is exactly why a lower ceiling cannot be moved into.
 */
const spent = (overrides: {
  readonly allowed: {
    readonly included: number;
    readonly cap?: number;
    readonly moneyCap?: number;
  };
  readonly used: number;
  readonly billed: number;
}): SubscribedState =>
  ({
    _tag: "Subscribed",
    tier: "spent",
    status: "active",
    period: { start: at, end: monthLater, anchorTz: "UTC" },
    interval: "month",
    cancelAtPeriodEnd: false,
    credits: 0,
    creditsExpire: "period",
    rates: {},
    currency: "usd",
    // The tier it is on now: generous enough that every unit so far was legal.
    usage: { messages: overrides.used },
    billed: { messages: overrides.billed },
    remaining: { messages: 0 },
    holds: {},
    allowances: {
      messages: allowance(messages, {
        included: 0,
        overage: "bill",
        unitPrice: { amount: 2, currency: "usd" },
        moneyCap: 1_000,
      }),
    },
    refs: {},
    trialUsed: true,
    dedupeKeys: {},
    dunningAttempts: 0,
  }) as never;

const changeTo = (next: {
  readonly included: number;
  readonly cap?: number;
  readonly moneyCap?: number;
}): ChangeTier =>
  new ChangeTier({
    tier: "cheaper",
    allowances: {
      messages: allowance(messages, {
        included: next.included,
        overage: "bill",
        unitPrice: { amount: 2, currency: "usd" },
        ...(next.cap === undefined ? {} : { cap: next.cap }),
        ...(next.moneyCap === undefined ? {} : { moneyCap: next.moneyCap }),
      }),
    },
    credits: 0,
    creditsExpire: "period",
    rates: {},
  });

const decide = (state: SubscribedState, command: ChangeTier) =>
  Subscription.predict(state, command, {
    id: Subscription.ref("acct_ceiling").id,
    now: at,
    context: Context.make(Actor, system("test")),
  });

describe("a tier change into a ceiling already passed", () => {
  it("refuses money the period has already billed past the new cap", () => {
    // 80 minor units billed; the new tier allows 50 this period. Accepting the
    // change would leave a standing where every later TrackUsage answers
    // `MoneyCapExceeded` until the period closes.
    const state = spent({ allowed: { included: 0 }, used: 100, billed: 80 });
    const verdict = decide(state, changeTo({ included: 0, moneyCap: 50 }));

    expect(verdict._tag).toBe("Rejected");
    if (verdict._tag !== "Rejected") return;
    expect(verdict.rejection).toBeInstanceOf(DowngradeBelowSpend);
    expect(verdict.rejection).toMatchObject({ feature: "messages", moneyCap: 50, billed: 80 });
  });

  it("allows money that still fits the new cap", () => {
    const state = spent({ allowed: { included: 0 }, used: 100, billed: 40 });
    const verdict = decide(state, changeTo({ included: 0, moneyCap: 50 }));
    expect(verdict._tag).toBe("Accepted");
  });

  it("refuses units the period has already used past `included + cap`", () => {
    // `cap` is a ceiling on billed units; `used` is what the period counted, and
    // all of it is billed because `included` was 0.
    const state = spent({ allowed: { included: 0 }, used: 200, billed: 400 });
    const verdict = decide(state, changeTo({ included: 100, cap: 50 }));

    expect(verdict._tag).toBe("Rejected");
    if (verdict._tag !== "Rejected") return;
    expect(verdict.rejection).toBeInstanceOf(DowngradeBelowCeiling);
    expect(verdict.rejection).toMatchObject({ feature: "messages", ceiling: 150, used: 200 });
  });

  it("allows units that still fit the new ceiling", () => {
    const state = spent({ allowed: { included: 0 }, used: 120, billed: 240 });
    const verdict = decide(state, changeTo({ included: 100, cap: 50 }));
    expect(verdict._tag).toBe("Accepted");
  });

  it("says nothing about a tier that states no ceiling", () => {
    const state = spent({ allowed: { included: 0 }, used: 200, billed: 400 });
    const verdict = decide(state, changeTo({ included: 100 }));
    expect(verdict._tag).toBe("Accepted");
  });
});
