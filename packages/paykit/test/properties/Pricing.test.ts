import { expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance } from "../../src/Allowance.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { prorate } from "../../src/Proration.ts";
import { ChangeTier } from "../../src/Subscription/ChangeTier.command.ts";
import { PeriodEnded } from "../../src/Subscription/PeriodEnded.command.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import {
  initialSubscriptionState,
  type SubscribedState,
  SubscriptionState,
} from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";

const freeTier = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });
const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});
const scaleTier = tier({
  id: "scale",
  price: { amount: 9900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 5000, overage: "block" })],
});
const testCatalog = Effect.runSync(
  catalog({ features: [messages], tiers: [freeTier, proTier, scaleTier] }),
);
const free = allowancesOf(testCatalog, "free")!;
const pro = allowancesOf(testCatalog, "pro")!;
const scale = allowancesOf(testCatalog, "scale")!;
const freePrice = undefined;
const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
const scalePrice = { amount: 9900, currency: "usd", interval: "month" as const };

const start = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const ref = Subscription.ref("acct_price");

type AnyEvent = { readonly _tag: string };

const ctx = (now: DateTime.Utc, commandId: string) => ({
  id: ref.id,
  commandId,
  stream: `Subscription/${ref.id}`,
  version: 0,
  now,
});

const decide = Subscription.definition.decide as unknown as Record<
  string,
  (state: unknown, command: unknown, ctx: unknown) => unknown
>;
const evolve = Subscription.definition.evolve as unknown as Record<
  string,
  (state: unknown, event: unknown, envelope: unknown) => unknown
>;

const fold = (events: ReadonlyArray<AnyEvent>, now = start): unknown =>
  events.reduce<unknown>(
    (current, event, index) =>
      evolve[event._tag]!(current, event, {
        id: ref.id,
        stream: `Subscription/${ref.id}`,
        seq: index + 1,
        at: now,
        commandId: "cmd",
        correlationId: "cmd",
      }),
    initialSubscriptionState,
  );

const canonical = (state: unknown) =>
  Schema.encodeSync(SubscriptionState)(state as typeof initialSubscriptionState);

/** A tiny deterministic generator, so a failure is reproducible. */
const next = (seed: number) => (seed * 1_103_515_245 + 12_345) % 2_147_483_648;

const tiers = [
  { id: "free", allowances: free, price: freePrice },
  { id: "pro", allowances: pro, price: proPrice },
  { id: "scale", allowances: scale, price: scalePrice },
] as const;

it("replaying the log reproduces the price the account was sold at", () => {
  const committed: AnyEvent[] = [];
  let state = initialSubscriptionState;
  let now = start;

  const apply = (command: { readonly _tag: string }) => {
    const decision = decide[command._tag]!(state, command, ctx(now, `cmd-${committed.length}`));
    if (!Array.isArray(decision)) return;
    committed.push(...(decision as AnyEvent[]));
    state = fold(committed, now) as typeof initialSubscriptionState;
  };

  apply(
    new Subscribe({
      credits: 0,
      creditsExpire: "period",
      rates: {},
      tier: "free",
      allowances: free,
    }),
  );
  let seed = 11;
  for (let step = 0; step < 60; step++) {
    seed = next(seed);
    const choice = tiers[seed % tiers.length]!;
    apply(
      new ChangeTier({
        tier: choice.id,
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: choice.allowances,
        ...(choice.price === undefined ? {} : { price: choice.price }),
      }),
    );
    if (step === 30) {
      now = DateTime.makeUnsafe("2030-02-01T00:00:00Z");
      apply(new PeriodEnded({ periodEnd: now }));
    }
  }

  // The rebuilt state and the walked state agree, prices included.
  const rebuilt = fold(committed, now);
  expect(canonical(rebuilt)).toEqual(canonical(state));

  // The price on the state is the price the log last recorded, never the catalog's.
  const lastPrice = committed
    .map((event) => event as { readonly priceAfter?: { readonly amount: number } })
    .filter((event) => event.priceAfter !== undefined)
    .at(-1)?.priceAfter;
  const current = rebuilt as SubscribedState;
  expect(current._tag).toBe("Subscribed");
  expect(current.price?.amount).toBe(lastPrice?.amount);
});

it("an activation records the price it was sold at", () => {
  const decision = decide.Subscribe!(
    initialSubscriptionState,
    new Subscribe({
      credits: 0,
      creditsExpire: "period",
      rates: {},
      tier: "pro",
      allowances: pro,
      price: proPrice,
    }),
    ctx(start, "subscribe"),
  ) as ReadonlyArray<{ readonly _tag: string; readonly price?: { readonly amount: number } }>;
  const activated = decision[0]!;
  expect(activated._tag).toBe("SubscriptionActivated");
  expect(activated.price?.amount).toBe(1900);
});

it("a tier change records both prices it moved between", () => {
  const opened = decide.Subscribe!(
    initialSubscriptionState,
    new Subscribe({
      credits: 0,
      creditsExpire: "period",
      rates: {},
      tier: "pro",
      allowances: pro,
      price: proPrice,
    }),
    ctx(start, "subscribe"),
  ) as ReadonlyArray<AnyEvent>;
  const state = fold(opened);
  const decision = decide.ChangeTier!(
    state,
    new ChangeTier({
      tier: "scale",
      credits: 0,
      creditsExpire: "period",
      rates: {},
      allowances: scale,
      price: scalePrice,
      // A priced change carries the proration the model would compute.
      proration: prorate({
        from: proPrice,
        to: scalePrice,
        period: { start, end: DateTime.makeUnsafe("2030-02-01T00:00:00Z") },
        at: start,
      })!,
    }),
    ctx(start, "change"),
  ) as ReadonlyArray<{
    readonly priceBefore?: { readonly amount: number };
    readonly priceAfter?: { readonly amount: number };
  }>;
  expect(decision[0]?.priceBefore?.amount).toBe(1900);
  expect(decision[0]?.priceAfter?.amount).toBe(9900);

  // Downgrading to a free tier clears the price rather than keeping the old one.
  const downgraded = fold([
    ...opened,
    ...(decision as ReadonlyArray<AnyEvent>),
    ...(decide.ChangeTier!(
      fold([...opened, ...(decision as ReadonlyArray<AnyEvent>)]),
      new ChangeTier({
        tier: "free",
        credits: 0,
        creditsExpire: "period",
        rates: {},
        allowances: free,
        // Downgrading to a free tier credits the unused scale price.
        proration: prorate({
          from: scalePrice,
          to: undefined,
          period: { start, end: DateTime.makeUnsafe("2030-02-01T00:00:00Z") },
          at: start,
        })!,
      }),
      ctx(start, "downgrade"),
    ) as ReadonlyArray<AnyEvent>),
  ]) as SubscribedState;
  expect(downgraded.price).toBeUndefined();
});

it("a period boundary does not move the price", () => {
  const opened = decide.Subscribe!(
    initialSubscriptionState,
    new Subscribe({
      credits: 0,
      creditsExpire: "period",
      rates: {},
      tier: "pro",
      allowances: pro,
      price: proPrice,
    }),
    ctx(start, "subscribe"),
  ) as ReadonlyArray<AnyEvent>;
  const monthLater = DateTime.makeUnsafe("2030-02-01T00:00:00Z");
  const closed = decide.PeriodEnded!(
    fold(opened),
    new PeriodEnded({ periodEnd: monthLater }),
    ctx(monthLater, "close"),
  ) as ReadonlyArray<AnyEvent>;
  const after = fold([...opened, ...closed], monthLater) as SubscribedState;
  expect(after.price?.amount).toBe(1900);
  expect(after.period.start).toEqual(monthLater);
});
