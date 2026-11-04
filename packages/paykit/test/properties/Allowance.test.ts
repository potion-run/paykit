import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance } from "../../src/Allowance.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { ClosePeriod, UsageReset } from "../../src/Subscription/ClosePeriod.command.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import {
  initialSubscriptionState,
  SubscriptionState,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { TrackUsage, UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";

const blockTier = tier({
  id: "block",
  grants: [allowance(messages, { included: 100, overage: "block" })],
});
const billTier = tier({
  id: "bill",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 100, overage: "bill" })],
});
const unlimitedTier = tier({
  id: "unlimited",
  price: { amount: 9900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: "unlimited" })],
});

const testCatalog = Effect.runSync(
  catalog({ features: [messages], tiers: [blockTier, billTier, unlimitedTier] }),
);

const block = allowancesOf(testCatalog, "block")!;
const bill = allowancesOf(testCatalog, "bill")!;
const unlimited = allowancesOf(testCatalog, "unlimited")!;
const price = { amount: 1900, currency: "usd", interval: "month" as const };
const at = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const ref = Subscription.ref("acct_prop");

const ctx = (commandId: string, now = at) => ({
  id: ref.id,
  commandId,
  stream: `Subscription/${ref.id}`,
  version: 0,
  now,
});

type AnyEvent = { readonly _tag: string };

const evolve = (state: unknown, events: ReadonlyArray<AnyEvent>, now = at) =>
  events.reduce((current, event, index) => {
    const handler = (
      Subscription.definition.evolve as unknown as Record<
        string,
        (state: unknown, event: unknown, envelope: unknown) => unknown
      >
    )[event._tag]!;
    return handler(current, event, {
      id: ref.id,
      stream: `Subscription/${ref.id}`,
      seq: index + 1,
      at: now,
      commandId: "cmd",
      correlationId: "cmd",
    });
  }, state);

const decide = (
  state: unknown,
  command: { readonly _tag: string },
  commandId = "cmd",
  now = at,
) => {
  const handler = (
    Subscription.definition.decide as unknown as Record<
      string,
      (state: unknown, command: unknown, ctx: unknown) => unknown
    >
  )[command._tag]!;
  return handler(state, command, ctx(commandId, now));
};

const activated = (tierId: string, allowances: typeof block) => {
  const subscribe = new Subscribe({
    tier: tierId,
    credits: 0,
    creditsExpire: "period",
    rates: {},
    allowances,
    ...(tierId === "bill" ? { price } : {}),
  });
  const events = decide(initialSubscriptionState, subscribe) as ReadonlyArray<AnyEvent>;
  return evolve(initialSubscriptionState, events) as SubscribedState;
};

const canonical = (state: unknown) =>
  Schema.encodeSync(SubscriptionState)(state as typeof initialSubscriptionState);

describe("allowance", () => {
  it("never lets a blocking allowance overspend, go negative, or rise inside a period", () => {
    let state = activated("block", block) as any;
    let remaining = state.remaining.messages as number;
    for (let amount = 1; amount <= 1000; amount += 7) {
      const decision = decide(state, new TrackUsage({ feature: "messages", amount })) as
        | ReadonlyArray<AnyEvent>
        | { readonly _tag: string };
      if (Array.isArray(decision)) {
        state = evolve(state, decision);
        const event = decision[0] as UsageRecorded;
        expect(event.usedAfter).toBeLessThanOrEqual(100);
        // A blocking allowance always keeps a count to report.
        expect(event.remainingAfter).not.toBeNull();
        const after = event.remainingAfter ?? 0;
        expect(after).toBeGreaterThanOrEqual(0);
        expect(after).toBeLessThanOrEqual(remaining);
        remaining = after;
      } else {
        expect((decision as { readonly _tag: string })._tag).toBe("AllowanceExceeded");
      }
    }
  });

  it("lets a bill allowance go past included and keeps used reproducible", () => {
    let state = activated("bill", bill) as any;
    for (const amount of [50, 50, 50, 50]) {
      const decision = decide(state, new TrackUsage({ feature: "messages", amount })) as
        | ReadonlyArray<AnyEvent>
        | { readonly _tag: string };
      expect(Array.isArray(decision)).toBe(true);
      if (Array.isArray(decision)) {
        state = evolve(state, decision);
        const event = decision[0] as UsageRecorded;
        expect(event.usedAfter).toBe(state.usage.messages);
        expect(event.remainingAfter).toBe(state.remaining.messages);
      }
    }
    expect(state.usage.messages).toBe(200);
    expect(state.remaining.messages).toBe(-100);
  });

  it("restores the included amount only at ClosePeriod", () => {
    let state = activated("block", block) as any;
    state = evolve(
      state,
      decide(
        state,
        new TrackUsage({ feature: "messages", amount: 80 }),
      ) as any as ReadonlyArray<AnyEvent>,
    );
    expect(state.remaining.messages).toBe(20);
    const closed = decide(
      state,
      new ClosePeriod({ periodEnd: state.period.end }),
      "close",
      state.period.end,
    ) as ReadonlyArray<AnyEvent>;
    expect(closed.length).toBe(3);
    state = evolve(state, closed, state.period.end);
    expect(state.usage.messages ?? 0).toBe(0);
    expect(state.remaining.messages).toBe(100);
  });

  it("never blocks an unlimited allowance, and closes a period back to no count", () => {
    let state = activated("unlimited", unlimited) as any;
    expect(state.remaining.messages).toBeNull();
    for (const amount of [1_000, 1_000_000]) {
      const decision = decide(state, new TrackUsage({ feature: "messages", amount })) as
        | ReadonlyArray<AnyEvent>
        | { readonly _tag: string };
      // Never a rejection, however much is asked for.
      expect(Array.isArray(decision)).toBe(true);
      if (!Array.isArray(decision)) continue;
      state = evolve(state, decision);
      expect((decision[0] as UsageRecorded).remainingAfter).toBeNull();
    }
    expect(state.usage.messages).toBe(1_001_000);

    const closed = decide(
      state,
      new ClosePeriod({ periodEnd: state.period.end }),
      "close",
      state.period.end,
    ) as ReadonlyArray<AnyEvent>;
    const reset = closed.find((event) => event._tag === "UsageReset");
    expect(reset).toBeDefined();
    if (reset === undefined) return;
    // Nothing to reset: use counts return to zero, the allowance stays absent.
    expect((reset as UsageReset).remaining).toEqual({ messages: null });
    state = evolve(state, closed, state.period.end);
    expect(state.usage.messages ?? 0).toBe(0);
    expect(state.remaining.messages).toBeNull();
  });

  it("is deterministic: the same command and clock decide the same events", () => {
    const state = activated("bill", bill);
    const command = new TrackUsage({ feature: "messages", amount: 25 });
    const first = decide(state, command) as ReadonlyArray<AnyEvent>;
    const second = decide(state, command) as ReadonlyArray<AnyEvent>;
    expect(JSON.stringify(first.map((event) => ({ ...event })))).toBe(
      JSON.stringify(second.map((event) => ({ ...event }))),
    );
  });

  it("folds the same state from the committed events that decide carried", () => {
    const state = activated("bill", bill);
    const events: AnyEvent[] = [];
    let walked = state;
    for (const amount of [10, 20, 30]) {
      const decision = decide(walked, new TrackUsage({ feature: "messages", amount })) as
        | ReadonlyArray<AnyEvent>
        | { readonly _tag: string };
      if (Array.isArray(decision)) {
        events.push(...decision);
        walked = evolve(walked, decision) as SubscribedState;
      }
    }
    const rebuilt = evolve(state, events) as SubscribedState;
    expect(canonical(rebuilt)).toEqual(canonical(walked));
    expect(walked.usage.messages).toBe(60);
  });
});
