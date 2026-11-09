import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { isFlagGrant, type Allowance } from "../../src/Allowance.ts";
import {
  allowancesOf,
  ratesOf,
  billedOf,
  grantTotalOf,
  includedRemainingOf,
  initialSubscriptionState,
  prepaidCreditsOf,
  remainingOf,
  reservedCreditsOf,
  reservedOf,
  usedOf,
  type SubscriptionState,
} from "../../src/Subscription/Subscription.state.ts";
import { assertProperty } from "../support/Property.ts";
import { Amount, commandOf, decideAt, evolveAt, isAccepted, Script, start } from "./Arbitraries.ts";

type Event = Readonly<{ readonly _tag: string }>;

/**
 * The allowance each feature is conserving this period: what the tier
 * included, plus what the last rollover carried, a granted source, or a sweep
 * an archived entity returned. Activation, trial start and a customer's tier
 * change begin a fresh base; a `UsageReset` starts the next one. A scoped plan
 * change and a scoped grant belong to that scope, not to the customer's base.
 */
const updateBases = (
  bases: Map<string, number | null>,
  events: ReadonlyArray<Event>,
  state: SubscriptionState,
): void => {
  const grantsOf = (feature: string): number =>
    state._tag === "Subscribed" ? grantTotalOf(state, feature) : 0;

  const addBase = (feature: string, amount: number): void => {
    const base = bases.get(feature);

    if (base === undefined || base === null) return;
    bases.set(feature, base + amount);
  };

  for (const event of events) {
    switch (event._tag) {
      case "SubscriptionActivated":
      case "TrialStarted": {
        const allowances = (event as unknown as { readonly allowances: Record<string, Allowance> })
          .allowances;

        for (const [feature, allowance] of Object.entries(allowances)) {
          const included = includedRemainingOf(allowance);

          // A grant from a previous standing is carried into the new one, so
          // the count it starts with is the plan's plus the grant's.
          bases.set(feature, included === null ? null : included + grantsOf(feature));
        }

        break;
      }

      case "PlanChanged": {
        if ((event as unknown as { readonly entity?: string }).entity !== undefined) break;

        const allowances = (event as unknown as { readonly allowances: Record<string, Allowance> })
          .allowances;

        for (const [feature, allowance] of Object.entries(allowances)) {
          const included = includedRemainingOf(allowance);

          // A standalone grant survives a plan change, so the new plan's count
          // plus the grants the standing still holds is what the period began
          // with (ADR 0037).
          bases.set(feature, included === null ? null : included + grantsOf(feature));
        }

        break;
      }

      case "BalanceGranted": {
        const granted = event as unknown as {
          readonly feature: string;
          readonly granted: number;
          readonly entity?: string;
        };

        if (granted.entity !== undefined) break;
        addBase(granted.feature, granted.granted);
        break;
      }

      case "BalanceExpired": {
        const expired = event as unknown as {
          readonly feature: string;
          readonly amount: number;
          readonly entity?: string;
        };

        if (expired.entity !== undefined) break;
        addBase(expired.feature, -expired.amount);
        break;
      }

      case "EntityArchived": {
        const archive = event as unknown as {
          readonly returned: ReadonlyArray<{ readonly feature: string; readonly amount: number }>;
          readonly returnedQuantities: ReadonlyArray<{
            readonly feature: string;
            readonly quantity: number;
          }>;
        };

        for (const returned of archive.returned) addBase(returned.feature, returned.amount);

        for (const returned of archive.returnedQuantities) {
          addBase(returned.feature, returned.quantity);
        }

        break;
      }

      case "UsageReset": {
        const reset = event as unknown as {
          readonly remaining: Record<string, number | null>;
          readonly kept?: Record<string, boolean>;
        };

        if (state._tag !== "Subscribed") break;

        for (const [feature, remaining] of Object.entries(reset.remaining)) {
          // A `resets: "never"` feature continued the same count across the
          // boundary, so its base did not move.
          if (reset.kept?.[feature] === true) continue;

          // The event's remaining already includes the carried units and every
          // surviving grant; usage starts again at zero.
          bases.set(feature, remaining);
        }

        break;
      }
    }
  }
};

/**
 * The numbers a standing may never contradict, whatever command produced it:
 * a pool that does not go negative and still covers every open hold, a hold
 * that is a fold of the holds themselves, a counted allowance whose use,
 * reservations and remainder still add up to what the period began with, and
 * no ceiling the period already passed.
 */
const invariantsHold = (
  state: SubscriptionState,
  bases: ReadonlyMap<string, number | null>,
): boolean => {
  if (state._tag !== "Subscribed") {
    const credits = state.credits ?? 0;
    const prepaid = state.prepaidCredits ?? 0;

    if (credits < 0 || prepaid < 0 || prepaid > credits) return false;

    return Object.values(state.usage ?? {}).every((used) => used >= 0);
  }

  // The pool covers every open hold. A spend that ignores reservations would
  // otherwise leave settle with credits it cannot bill.
  if (state.credits < 0) return false;

  if (state.credits < reservedCreditsOf(state)) return false;
  // A one-off pack is a part of the pool, never more than the pool and never
  // negative, so a period close can subtract the plan's credits and leave it.
  const prepaid = prepaidCreditsOf(state);

  if (prepaid < 0 || prepaid > state.credits) return false;

  for (const [feature, allowance] of Object.entries(allowancesOf(state))) {
    const used = usedOf(state, feature);
    const reserved = reservedOf(state, feature);
    const remaining = remainingOf(state, feature);

    if (used < 0 || reserved < 0) return false;

    if (isFlagGrant(allowance)) {
      // A flag is granted, not counted: no usage, no reservation, no count.
      if (remaining !== null) return false;

      if (used !== 0 || reserved !== 0) return false;
      continue;
    }

    if (allowance.included === "unlimited") {
      // An unbounded allowance has no plan count to spend down. A standalone
      // grant is still a source, though, and a standing carries its units in
      // `remaining`; no grant means there is no count at all.
      const grants = grantTotalOf(state, feature);

      if (grants === 0 ? remaining !== null : remaining !== grants) return false;
      continue;
    }

    if (remaining === null) return false;

    // A blocking allowance never spends past zero.
    if (allowance.overage === "block" && remaining < 0) return false;

    // A cap is a ceiling on the units a period may bill, holds included. Every
    // command that could cross one refuses — usage and holds in the transaction
    // that would record them, and `ChangeTier` when the move itself would land
    // the standing past it — so no reachable state is over its ceiling.
    if (allowance.cap !== undefined && used + reserved > allowance.included + allowance.cap) {
      return false;
    }

    // The same, in money. `billed` is kept across a tier change, so a change
    // under a smaller money cap is a ceiling already passed; `ChangeTier`
    // refuses it (`DowngradeBelowSpend`) for exactly that reason.
    if (allowance.moneyCap !== undefined && billedOf(state, feature) > allowance.moneyCap) {
      return false;
    }

    // Use, reservations and the remainder are one count: none of them may
    // drift from what the period began with.
    const base = bases.get(feature);

    if (base !== undefined && base !== null && used + reserved + remaining !== base) return false;
  }

  for (const feature of Object.keys(ratesOf(state))) {
    if (usedOf(state, feature) < 0) return false;
  }

  return true;
};

describe("cross-family invariants", () => {
  it.effect("every generated script keeps the pool and every allowance conserved", () =>
    assertProperty(
      Arbitrary.schema(Script),
      (script) => {
        let state: SubscriptionState = initialSubscriptionState;
        let now = start;
        const bases = new Map<string, number | null>();

        if (!invariantsHold(state, bases)) return false;

        for (const [index, step] of script.steps.entries()) {
          now = DateTime.add(now, { days: step.advanceDays });
          const command = commandOf(step.command, state, now);
          const decision = decideAt(state, command, now, `invariant-${index}`);

          if (!isAccepted(decision)) continue;
          state = evolveAt(state, decision, now, `invariant-${index}`);
          updateBases(bases, decision, state);

          if (!invariantsHold(state, bases)) return false;
        }

        return true;
      },
      { runs: 100, size: 50 },
    ),
  );
});

const MoneyStep = Schema.Union([
  Schema.TaggedStruct("TrackUsage", { amount: Amount }),
  Schema.TaggedStruct("ChangeTier", {
    tier: Schema.Literals(["metered", "capped", "cheap", "recurring"]),
  }),
  Schema.TaggedStruct("ClosePeriod", {}),
]);

type MoneyStep = typeof MoneyStep.Type;

/**
 * A history that opens on a money tier and keeps moving between them. The
 * shared generator reaches a money allowance only by chance, and reaching a
 * ceiling has to happen *before* a tier change that would land under it, so the
 * general script rarely produces the pair. This one bills and changes tier in
 * the same script by construction.
 */
const MoneyHistory = Schema.Struct({
  tier: Schema.Literals(["metered", "capped", "cheap", "recurring"]),
  steps: Schema.Array(MoneyStep).pipe(Schema.check(Schema.isMaxLength(40))),
});

type MoneyHistory = typeof MoneyHistory.Type;

describe("cross-family invariants on the money plane", () => {
  it.effect("no reachable standing is past a unit ceiling or a money ceiling", () =>
    assertProperty(
      Arbitrary.schema(MoneyHistory),
      (history) => {
        let state: SubscriptionState = initialSubscriptionState;
        let now = start;
        const bases = new Map<string, number | null>();

        const run = (step: {
          readonly command: Parameters<typeof commandOf>[0];
          readonly advanceDays: number;
        }): boolean => {
          now = DateTime.add(now, { days: step.advanceDays });
          const command = commandOf(step.command, state, now);
          const decision = decideAt(state, command, now, "money-invariant");

          if (!isAccepted(decision)) return true;
          state = evolveAt(state, decision, now, "money-invariant");
          updateBases(bases, decision, state);

          return invariantsHold(state, bases);
        };

        const steps: ReadonlyArray<{
          readonly command: Parameters<typeof commandOf>[0];
          readonly advanceDays: number;
        }> = [
          { command: { _tag: "Subscribe", tier: history.tier }, advanceDays: 0 },
          ...history.steps.map((step) => ({ command: step, advanceDays: 0 })),
        ];

        for (const step of steps) {
          if (!run(step)) return false;
        }

        return true;
      },
      { runs: 120, size: 40 },
    ),
  );
});
