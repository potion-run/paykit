import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance, unitPriceKey, type Allowance, type UnitPrice } from "../../src/Allowance.ts";
import { catalog } from "../../src/Catalog.ts";
import { messages } from "../../src/Feature.ts";
import {
  Entitlements,
  initialEntitlements,
  type EntitlementsState,
} from "../../src/Subscription/Entitlements.view.ts";
import { Hold } from "../../src/Subscription/Hold.command.ts";
import { SettleHold } from "../../src/Subscription/SettleHold.command.ts";
import {
  billedOf,
  chargeOf,
  initialSubscriptionState,
  remainingOf,
  usedOf,
  type SubscribedState,
  type SubscriptionState,
} from "../../src/Subscription/Subscription.state.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { assertProperty } from "../support/Property.ts";
import {
  Amount,
  commandOf,
  decideAt,
  evolveAt,
  isAccepted,
  propertyAccount,
  ScriptStep,
  start,
  subscribedIn,
} from "./Arbitraries.ts";

type Event = Readonly<{ readonly _tag: string }>;

/** The three tiers from the fixture catalog that price what they bill. */
const MoneyTier = Schema.Literals(["metered", "capped", "recurring"]);
type MoneyTier = typeof MoneyTier.Type;

/**
 * A script that opens on a money tier before it does anything else. The shared
 * generator reaches a postpaid allowance only by chance, and the money state a
 * generated history lands in is the whole subject here.
 */
const MoneyScript = Schema.Struct({
  tier: MoneyTier,
  steps: Schema.Array(ScriptStep).pipe(Schema.check(Schema.isMaxLength(60))),
});
type MoneyScript = typeof MoneyScript.Type;

/**
 * The units a period recorded at each price, keyed by `unitPriceKey`. The view
 * keeps this per price so a mid-period change reports each unit at the price it
 * was recorded at; a fold of `billable` has to reproduce it exactly.
 */
type PriceLedger = Map<string, { readonly unitPrice: UnitPrice; readonly quantity: number }>;

const withUnits = (
  ledger: PriceLedger | undefined,
  unitPrice: UnitPrice,
  units: number,
): PriceLedger => {
  const key = unitPriceKey(unitPrice);
  const current = ledger ?? new Map();
  return new Map(current).set(key, {
    unitPrice,
    quantity: (current.get(key)?.quantity ?? 0) + units,
  });
};

/**
 * What the log says the money is. Every field here is rebuilt from the events
 * alone, so comparing it to the aggregate and to the read model is the claim
 * that a counter is a fold and not a number someone remembered.
 */
interface Ledger {
  readonly billed: Map<string, number>;
  readonly limits: Map<string, number | undefined>;
  readonly prices: Map<string, PriceLedger>;
}

const handlers = Entitlements.definition.evolve as unknown as Record<
  string,
  (state: EntitlementsState, event: Event, context: unknown) => EntitlementsState
>;

const foldView = (view: EntitlementsState, events: ReadonlyArray<Event>): EntitlementsState =>
  events.reduce<EntitlementsState>((current, event) => {
    const handler = handlers[event._tag];
    return handler === undefined
      ? current
      : handler(current, event, { key: { id: propertyAccount } });
  }, view);

/**
 * Apply one committed decision to the ledger, checking the arithmetic each
 * event carries as it goes. `false` means an event bills money the log cannot
 * account for.
 */
const applyMoney = (ledger: Ledger, events: ReadonlyArray<Event>): boolean => {
  for (const event of events) {
    const value = event as unknown as Readonly<Record<string, unknown>>;
    switch (event._tag) {
      case "SubscriptionActivated":
      case "TrialStarted": {
        const allowances = value.allowances as Readonly<Record<string, Allowance>>;
        for (const feature of Object.keys(allowances)) {
          ledger.billed.set(feature, 0);
          ledger.limits.set(feature, allowances[feature]!.moneyCap);
          ledger.prices.set(feature, new Map());
        }
        break;
      }
      case "TierChanged": {
        // A tier change carries the period's billed money over: it moves what a
        // unit costs from here on, not what the account has already spent.
        const allowances = value.allowances as Readonly<Record<string, Allowance>>;
        for (const [feature, grant] of Object.entries(allowances)) {
          ledger.limits.set(feature, grant.moneyCap);
        }
        break;
      }
      case "UsageReset": {
        const kept = (value.kept ?? {}) as Readonly<Record<string, boolean>>;
        for (const feature of ledger.billed.keys()) {
          if (kept[feature] === true) continue;
          ledger.billed.set(feature, 0);
          ledger.prices.set(feature, new Map());
        }
        break;
      }
      case "UsageRecorded": {
        const feature = value.feature as string;
        const unitPrice = value.unitPrice as UnitPrice | undefined;
        const charge = value.charge as number | undefined;
        const billable = value.billable as number | undefined;
        const billedAfter = value.billedAfter as number | undefined;
        if (unitPrice === undefined) {
          // A counted allowance records usage without money on it.
          if (charge !== undefined || billable !== undefined || billedAfter !== undefined) {
            return false;
          }
          break;
        }
        if (charge === undefined || billable === undefined || billedAfter === undefined) {
          return false;
        }
        // The bill is billable units at the price the event carries, and the
        // billable part is a part of what the event recorded.
        if (billable < 0 || billable > (value.amount as number)) return false;
        if (charge !== billable * unitPrice.amount) return false;
        const expected = (ledger.billed.get(feature) ?? 0) + charge;
        if (billedAfter !== expected) return false;
        // A ceiling is judged in the transaction that bills, so no event a
        // period records may pass it.
        const limit = ledger.limits.get(feature);
        if (limit !== undefined && billedAfter > limit) return false;
        ledger.billed.set(feature, billedAfter);
        ledger.prices.set(feature, withUnits(ledger.prices.get(feature), unitPrice, billable));
        break;
      }
    }
  }
  return true;
};

/** The money the aggregate and the read model must both report from `ledger`. */
const moneyAgrees = (
  state: SubscriptionState,
  view: EntitlementsState,
  ledger: Ledger,
): boolean => {
  if (state._tag !== "Subscribed") return true;
  for (const feature of Object.keys(state.allowances)) {
    const expected = ledger.billed.get(feature) ?? 0;
    if (billedOf(state, feature) !== expected) return false;
    const entry = view.features[feature];
    if (entry === undefined) return false;
    // The read model `check()` answers from reports the same money the write
    // path holds. A read that under-reports `billed` offers a cap the account
    // has already reached.
    if ((entry.billed ?? 0) !== expected) return false;
    const prices = ledger.prices.get(feature) ?? new Map<string, never>();
    const recorded = entry.priced ?? {};
    if (Object.keys(recorded).length !== prices.size) return false;
    for (const [key, priced] of prices) {
      const seen = recorded[key];
      if (seen === undefined) return false;
      if (seen.quantity !== priced.quantity) return false;
      if (unitPriceKey(seen.unitPrice) !== key) return false;
    }
  }
  return true;
};

describe("money is a fold of the log", () => {
  it.effect("billed money, its ceiling and the read model all come from the events", () =>
    assertProperty(
      Arbitrary.schema(MoneyScript),
      (script) => {
        let state: SubscriptionState = initialSubscriptionState;
        let view = initialEntitlements;
        const ledger: Ledger = { billed: new Map(), limits: new Map(), prices: new Map() };
        let now = start;

        const steps: ReadonlyArray<ScriptStep> = [
          { command: { _tag: "Subscribe", tier: script.tier }, advanceDays: 0 },
          ...script.steps,
        ];

        for (const [index, step] of steps.entries()) {
          now = DateTime.add(now, { days: step.advanceDays });
          const command = commandOf(step.command, state, now);
          const decision = decideAt(state, command, now, `money-${index}`);
          if (!isAccepted(decision)) {
            // A refusal writes nothing: the money the standing reports is the
            // money it held before it asked.
            if (!moneyAgrees(state, view, ledger)) return false;
            continue;
          }
          if (!applyMoney(ledger, decision)) return false;
          state = evolveAt(state, decision, now, `money-${index}`);
          view = foldView(view, decision);
          if (!moneyAgrees(state, view, ledger)) return false;
        }

        return true;
      },
      { runs: 100, size: 50 },
    ),
  );
});

const meteredTier = tier({
  id: "metered",
  price: { amount: 2_900, currency: "usd", interval: "month" },
  grants: [
    allowance(messages, {
      included: 100,
      overage: "bill",
      unitPrice: { amount: 5, currency: "usd" },
      moneyCap: 1_500,
    }),
  ],
});

const meteredCatalog = Effect.runSync(catalog({ features: [messages], tiers: [meteredTier] }));
const unitPrice = { amount: 5, currency: "usd" } as const;
const included = 100;

const HoldCase = Schema.Struct({
  held: Amount,
  settled: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 500 }))),
});

describe("a kept allowance's money", () => {
  /**
   * The smallest history the randomized property above shrank to: a close on a
   * `resets: "never"` postpaid allowance. The write path keeps `billed` (the
   * period did not end for that feature) and the read path used to zero it, so
   * `check()` offered money the standing had already spent. Pinned here as a
   * case of its own: a generated script reaches this shape only sometimes.
   */
  it("survives the close, in the aggregate and in the read model", () => {
    let state: SubscriptionState = initialSubscriptionState;
    let view = initialEntitlements;
    let now = start;
    const run = (command: { readonly _tag: string }, name: string) => {
      const decided = decideAt(state, command, now, name);
      if (!isAccepted(decided)) throw new Error(`${name} was refused: ${decided._tag}`);
      state = evolveAt(state, decided, now, name);
      view = foldView(view, decided);
      return decided;
    };

    run(commandOf({ _tag: "Subscribe", tier: "recurring" }, state, now), "open");
    run(new TrackUsage({ feature: "messages", amount: 25 }), "track");
    const active = (): SubscribedState => {
      if (state._tag !== "Subscribed") throw new Error("the standing never activated");
      return state;
    };

    // 25 units, 10 of them included, at 2 minor units each.
    const billed = 30;
    if (billedOf(active(), "messages") !== billed) throw new Error("the track did not bill");

    now = active().period.end;
    const closed = run(commandOf({ _tag: "ClosePeriod" }, state, now), "close");
    const reset = closed.find((event) => event._tag === "UsageReset") as
      | { readonly kept?: Readonly<Record<string, boolean>> }
      | undefined;
    if (reset?.kept?.messages !== true) throw new Error("the close did not keep the feature");

    if (billedOf(active(), "messages") !== billed) throw new Error("the close moved the bill");
    const entry = view.features["messages"];
    if (entry === undefined) throw new Error("the read model lost the feature");
    if ((entry.billed ?? 0) !== billed) throw new Error("the read model lost the bill");
    // The split is kept for the same reason: the units are still this
    // feature's to report when the standing next closes.
    if (entry.priced?.["usd:2"]?.quantity !== 15) throw new Error("the read model lost the split");
  });
});

describe("holds and money", () => {
  it.effect("a settled hold bills what tracking the same units would", () =>
    assertProperty(
      Arbitrary.schema(HoldCase),
      ({ held, settled }) => {
        // A settle may bill no more than the hold holds; that ceiling is the
        // hold's own, and it has its own suite.
        if (settled > held) return true;

        const base = subscribedIn(meteredCatalog, "metered");
        const billedBefore = billedOf(base, "messages");

        const tracked = decideAt(
          base,
          new TrackUsage({ feature: "messages", amount: settled }),
          start,
          "track",
        );
        const reserved = decideAt(
          base,
          new Hold({
            holdId: "money-hold",
            feature: "messages",
            amount: held,
            expiresAt: DateTime.add(start, { days: 1 }),
          }),
          start,
          "hold",
        );
        // The promise itself was refused, so there is no bill to compare.
        if (!isAccepted(reserved)) return true;
        const settledState = evolveAt(base, reserved, start, "hold") as SubscribedState;
        const billed = decideAt(
          settledState,
          new SettleHold({ holdId: "money-hold", amount: settled }),
          start,
          "settle",
        );

        // The same units are judged the same way whichever door they came
        // through: a hold is a promise to bill, not a second charge and not a
        // way around a ceiling.
        if (isAccepted(tracked) !== isAccepted(billed)) return false;
        if (!isAccepted(tracked) || !isAccepted(billed)) return true;

        const afterTrack = evolveAt(base, tracked, start, "track") as SubscribedState;
        const afterSettle = evolveAt(settledState, billed, start, "settle") as SubscribedState;
        if (billedOf(afterTrack, "messages") !== billedOf(afterSettle, "messages")) return false;
        const settledBill = billedBefore + chargeOf(unitPrice, included, 0, settled);
        if (billedOf(afterSettle, "messages") !== settledBill) return false;
        // The hold took its units out when it was placed, so the settle leaves
        // the same count a track would: what it billed left once, and what it
        // did not bill came back.
        if (usedOf(afterTrack, "messages") !== usedOf(afterSettle, "messages")) return false;
        return remainingOf(afterTrack, "messages") === remainingOf(afterSettle, "messages");
      },
      { runs: 120, size: 40 },
    ),
  );
});
