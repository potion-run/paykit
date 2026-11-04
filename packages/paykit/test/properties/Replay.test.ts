import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance } from "../../src/Allowance.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import { ConsumeCredits } from "../../src/Subscription/ConsumeCredits.command.ts";
import { GrantCredits } from "../../src/Subscription/GrantCredits.command.ts";
import { PeriodEnded } from "../../src/Subscription/PeriodEnded.command.ts";
import { RecordPaymentFailure } from "../../src/Subscription/RecordPaymentFailure.command.ts";
import { Recover } from "../../src/Subscription/Recover.command.ts";
import { Resume } from "../../src/Subscription/Resume.command.ts";
import { ScheduleCancellation } from "../../src/Subscription/ScheduleCancellation.command.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import {
  initialSubscriptionState,
  SubscriptionState,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { TrackUsage, UsageRecorded } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";

const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});
const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [proTier] }));
const pro = allowancesOf(testCatalog, "pro")!;
const price = { amount: 1900, currency: "usd", interval: "month" as const };
const start = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const periodEnd = DateTime.makeUnsafe("2030-02-01T00:00:00Z");
const graceUntil = DateTime.makeUnsafe("2030-01-08T00:00:00Z");
const ref = Subscription.ref("acct_replay");

const ctx = (now: DateTime.Utc, commandId: string) => ({
  id: ref.id,
  commandId,
  stream: `Subscription/${ref.id}`,
  version: 0,
  now,
});

type AnyEvent = { readonly _tag: string };

const decide = (state: unknown, command: { readonly _tag: string }, now = start) =>
  (
    Subscription.definition.decide as unknown as Record<
      string,
      (state: unknown, command: unknown, ctx: unknown) => unknown
    >
  )[command._tag]!(state, command, ctx(now, `cmd-${command._tag}`));

const evolve = (state: unknown, events: ReadonlyArray<AnyEvent>, now = start) =>
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

const canonical = (state: unknown) =>
  Schema.encodeSync(SubscriptionState)(state as typeof initialSubscriptionState);

/** A tiny deterministic generator, so a failure is reproducible. */
const next = (seed: number) => (seed * 1_103_515_245 + 12_345) % 2_147_483_648;

describe("replay", () => {
  it("folds a generated command sequence back to the state it walked", () => {
    const opened = decide(
      initialSubscriptionState,
      new Subscribe({
        credits: 0,
        creditsExpire: "period",
        rates: {},
        tier: "pro",
        allowances: pro,
        price,
      }),
    ) as ReadonlyArray<AnyEvent>;
    let state = evolve(initialSubscriptionState, opened) as SubscribedState;
    const committed: AnyEvent[] = [...opened];
    let seed = 7;
    let now = start;

    for (let step = 0; step < 240; step++) {
      seed = next(seed);
      const choice = seed % 7;
      let command: { readonly _tag: string };
      if (choice === 0) {
        command = new TrackUsage({ feature: "messages", amount: (seed % 50) + 1 });
      } else if (choice === 1) {
        command = new GrantCredits({ amount: (seed % 400) + 1 });
      } else if (choice === 2) {
        command = new ConsumeCredits({ amount: (seed % 200) + 1 });
      } else if (choice === 3) {
        command = new RecordPaymentFailure({ reason: "card_declined", graceUntil });
      } else if (choice === 4) {
        command = new Recover();
      } else if (choice === 5) {
        command = new ScheduleCancellation();
      } else {
        command = new Resume();
      }

      if (step === 120) {
        now = periodEnd;
        command = new PeriodEnded({ periodEnd });
      }

      const decision = decide(state, command, now);
      if (Array.isArray(decision)) {
        committed.push(...(decision as AnyEvent[]));
        state = evolve(state, decision as AnyEvent[], now) as SubscribedState;
      }
    }

    const rebuilt = evolve(initialSubscriptionState, committed);
    expect(canonical(rebuilt)).toEqual(canonical(state));
    const lastReset = committed.map((event) => event._tag).lastIndexOf("UsageReset");
    expect(state.usage.messages ?? 0).toBe(
      committed
        .slice(lastReset + 1)
        .filter((event): event is UsageRecorded => event._tag === "UsageRecorded")
        .reduce((sum, event) => sum + event.amount, 0),
    );
  });

  it("decides the same command with the same clock identically", () => {
    const state = evolve(
      initialSubscriptionState,
      decide(
        initialSubscriptionState,
        new Subscribe({
          credits: 0,
          creditsExpire: "period",
          rates: {},
          tier: "pro",
          allowances: pro,
          price,
        }),
      ) as ReadonlyArray<AnyEvent>,
    );
    const command = new TrackUsage({ feature: "messages", amount: 12 });
    const first = decide(state, command) as ReadonlyArray<AnyEvent>;
    const second = decide(state, command) as ReadonlyArray<AnyEvent>;
    expect(canonical(evolve(state, first))).toEqual(canonical(evolve(state, second)));
  });
});
