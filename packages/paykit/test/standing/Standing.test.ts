import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import { allowance, type Allowances } from "../../src/Allowance.ts";
import { messages } from "../../src/Feature.ts";
import { activationOf, standingFrom } from "../../src/Subscription/Standing.ts";
import {
  initialSubscriptionState,
  type SubscriptionState,
} from "../../src/Subscription/Subscription.state.ts";

const start = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const end = DateTime.makeUnsafe("2030-02-01T00:00:00Z");
const period = { start, end, anchorTz: "UTC" };
const price = { amount: 1900, currency: "usd", interval: "month" as const };

const terms = (): Allowances => ({
  messages: allowance(messages, { included: 100, overage: "bill" }),
});

const activation = (over: { readonly credits?: number } = {}) =>
  activationOf({
    tier: "pro",
    allowances: terms(),
    credits: over.credits ?? 5_000,
    creditsExpire: "period",
    rates: {},
    price,
    period,
    statusAfter: "active",
  });

const subscribed = (state: SubscriptionState) => {
  if (state._tag !== "Subscribed") throw new Error("expected a subscribed standing");
  return state;
};

describe("activationOf", () => {
  it("records the grant, the period and the price's currency", () => {
    expect(activation()).toEqual({
      tier: "pro",
      allowances: terms(),
      remaining: { messages: 100 },
      credits: 5_000,
      creditsExpire: "period",
      rates: {},
      periodStart: start,
      periodEnd: end,
      anchorTz: "UTC",
      currency: "usd",
      price,
      statusAfter: "active",
    });
  });

  it("omits a zero pack part so an ordinary plan grows no field", () => {
    expect("prepaidCredits" in activation()).toBe(false);
    expect(activation({ credits: 5_000 }).prepaidCredits).toBe(undefined);
  });

  it("clamps the pack part to the pool it is part of", () => {
    expect(
      activationOf({
        tier: "pro",
        allowances: terms(),
        credits: 100,
        prepaidCredits: 500,
        creditsExpire: "period",
        rates: {},
        period,
        statusAfter: "active",
      }).prepaidCredits,
    ).toBe(100);
  });

  it("takes the currency from a unit price when the tier has no plan price", () => {
    const priced: Allowances = {
      messages: allowance(messages, {
        included: 100,
        overage: "bill",
        unitPrice: { amount: 2, currency: "eur" },
      }),
    };
    expect(
      activationOf({
        tier: "metered",
        allowances: priced,
        credits: 0,
        creditsExpire: "period",
        rates: {},
        period,
        previousCurrency: "usd",
        statusAfter: "active",
      }).currency,
    ).toBe("eur");
  });

  it("keeps the currency the standing already had when the tier states none", () => {
    expect(
      activationOf({
        tier: "free",
        allowances: terms(),
        credits: 0,
        creditsExpire: "never",
        rates: {},
        period,
        previousCurrency: "usd",
        statusAfter: "active",
      }).currency,
    ).toBe("usd");
  });
});

describe("standingFrom", () => {
  it("builds a fresh trial standing, with its deadline and cadence", () => {
    const state = subscribed(
      standingFrom(
        { ...activation(), trialEndsAt: end, statusAfter: "trialing" },
        initialSubscriptionState,
        { trialUsed: true },
      ),
    );

    expect(state.tier).toBe("pro");
    expect(state.status).toBe("trialing");
    expect(state.trialUsed).toBe(true);
    expect(state.trialEndsAt).toBe(end);
    expect(state.interval).toBe("month");
    expect(state.period).toEqual(period);
    expect(state.usage).toEqual({});
    expect(state.holds).toEqual({});
    expect(state.dedupeKeys).toEqual({});
    expect(state.dunningAttempts).toBe(0);
    expect(state.cancelAtPeriodEnd).toBe(false);
    // A fresh standing has no money from a previous one and nothing scheduled.
    expect("proration" in state).toBe(false);
    expect("pendingTier" in state).toBe(false);
  });

  it("carries the references and the trial flag a standing already had", () => {
    const previous: SubscriptionState = {
      ...initialSubscriptionState,
      refs: { stripe: { customer: "cus_1" } },
    };
    const trial = subscribed(
      standingFrom(
        { ...activation(), interval: "annual", trialEndsAt: end, statusAfter: "trialing" },
        previous,
        { trialUsed: true },
      ),
    );
    const converted = subscribed(standingFrom(activation(), trial, { trialUsed: trial.trialUsed }));

    expect(converted.refs).toEqual({ stripe: { customer: "cus_1" } });
    expect(converted.trialUsed).toBe(true);
    expect(converted.interval).toBe("month");
    expect("trialEndsAt" in converted).toBe(false);
  });

  it("takes the event's interval over the price's", () => {
    expect(
      subscribed(
        standingFrom({ ...activation(), interval: "annual" }, initialSubscriptionState, {
          trialUsed: false,
        }),
      ).interval,
    ).toBe("annual");
  });

  it("keeps the currency a standing had when the grant does not state one", () => {
    const previous = subscribed(
      standingFrom(activation(), initialSubscriptionState, { trialUsed: false }),
    );
    const grant = activation();
    const { currency: _currency, price: _price, ...bare } = grant;
    expect(subscribed(standingFrom(bare, previous, { trialUsed: false })).currency).toBe("usd");
  });
});
