import type { Included, Overage, Pricing } from "../Allowance.ts";
import type { RateCard } from "../Feature.ts";
import { chargeOf, creditRateOf, spendCeilingOf, type Standing } from "./Subscription.state.ts";

/**
 * The one place an allowance is judged.
 *
 * A standing answers two questions about one feature: whether an amount may be
 * recorded now (`decide`, `check()` and the read model's `allowed` all ask it),
 * and whether a tier change would leave the allowance below what the period
 * already consumed (`ChangeTier`, `Preview`, and the console's offered tiers ask
 * that one). Both are composed from the same facts — `used`, `reserved`,
 * `billed`, the included count, the two ceilings and the credit rate — so the
 * composition lives here instead of once per call site.
 *
 * Every function is pure and total: no clock, no provider, no ambient read, and
 * every feature shape produces an answer. The order the rules are applied in is
 * the order the write paths applied them, because the first refusal is the one
 * a caller sees.
 *
 */

/**
 * The per-feature facts one judgement reads.
 *
 * The aggregate builds these from a standing; both read models already carry
 * every field on a `FeatureEntitlement`. Keeping one shape is what lets the
 * write path, `check()` and the console ask the same question.
 */
export interface JudgedFeature {
  /** What happens past `included`: `block` is the only overage that runs out. */
  readonly overage: Overage;
  /**
   * What the tier includes: a count, or `"unlimited"`. `null` for a
   * credit-priced feature, which includes no units of its own. Only the money
   * rule reads it; the quantity ceiling is judged from `remaining`.
   */
  readonly included: Included | null;
  /** The units this period may bill past `included`, when the tier caps them. */
  readonly cap?: number;
  /**
   * How much of `remaining` a rollover added. A cap does not grow with a
   * rollover, so the ceiling subtracts it.
   */
  readonly carried?: number;
  /** The money ceiling for this period, when the allowance is postpaid. */
  readonly moneyCap?: number;
  /** How a billed unit is priced, when the allowance is postpaid. */
  readonly pricing?: Pricing;
  /** Money already billed for this feature this period, in minor units. */
  readonly billed: number;
  /** The period's units so far. */
  readonly used: number;
  /**
   * Units open holds keep out of `remaining`. On a credit-priced feature this
   * is the credits every open hold reserved, because the pool is shared.
   */
  readonly reserved: number;
  /**
   * Spendable now: the count, or the pool minus what open holds keep out.
   * `null` means there is no count — an unlimited allowance, or a flag.
   */
  readonly remaining: number | null;
  /** The rate card, when the feature is priced in credits. */
  readonly creditRates?: RateCard;
  /**
   * The quantity a non-consumable feature holds. A seat is set, not spent, so
   * it is judged against `cap`, not against a spendable `remaining`.
   */
  readonly quantity?: number;
}

/** What a caller asks to record. */
export interface Ask {
  /** How many units are being recorded, held or settled. */
  readonly amount: number;
  /** Which rate prices it, for a credit-priced feature. Omitted means `"default"`. */
  readonly dimension?: string;
  /** The event's properties, which a rate card's rules and multipliers match. */
  readonly properties?: Readonly<Record<string, string>>;
}

/**
 * May this amount be recorded right now?
 *
 * Each variant carries the evidence its own rejection needs, and nothing else:
 * a caller maps the tag to the command's tagged error and adds the account
 * facts that error also states. `Allowed` is the only tag that writes.
 */
export type Capacity =
  | { readonly _tag: "Allowed" }
  /** The account's standing forbids usage altogether. */
  | { readonly _tag: "Standing"; readonly standing: Standing }
  /** A blocking allowance — or a tier that grants the feature nothing — has no room. */
  | {
      readonly _tag: "Remaining";
      /** What the caller asked for. */
      readonly requested: number;
      /** Spendable before it. */
      readonly remaining: number;
    }
  /** The quantity ceiling is already spent: `amount > remaining + cap - carried`. */
  | {
      readonly _tag: "Ceiling";
      /** The units this period may bill past `included`. */
      readonly cap: number;
      /** What the period may still bill: `remaining + cap - carried`. */
      readonly headroom: number;
      readonly requested: number;
    }
  /** The money ceiling is already spent: `billed + promised > moneyCap`. */
  | {
      readonly _tag: "Money";
      /** The most this feature may bill in one period, in minor units. */
      readonly cap: number;
      readonly billed: number;
      /** What this request puts at risk, with every open hold. */
      readonly promised: number;
    }
  /** The account's credit pool cannot cover what the request costs. */
  | {
      readonly _tag: "Credits";
      /** What the request costs in credits: `amount × rate`. */
      readonly cost: number;
      /** The pool minus what open holds keep out. */
      readonly available: number;
    };

/**
 * The money rule on its own: `billed + promised > moneyCap`. The promised total
 * judges this request and every open hold as one run past `used`, so the
 * included room is counted once rather than once per bucket.
 *
 * Separate from {@link capacityOf} because `SettleHold` bills units a hold has
 * already taken: it must judge money without judging the quantity ceilings a
 * second time.
 */
export interface MoneyOverflow {
  /** The most this feature may bill in one period, in minor units. */
  readonly cap: number;
  /** What this feature has already billed this period. */
  readonly billed: number;
  /** What this request puts at risk, with every open hold. */
  readonly promised: number;
}

/**
 * The money ceiling, or `null` when the allowance states none or the request
 * fits. Pure: the caller decides which units `reserved` covers.
 */
export const moneyOverflowOf = (feature: JudgedFeature, amount: number): MoneyOverflow | null => {
  if (feature.moneyCap === undefined) return null;
  const promised = chargeOf(
    feature.pricing,
    feature.included,
    feature.used,
    amount + feature.reserved,
  );
  return feature.billed + promised > feature.moneyCap
    ? { cap: feature.moneyCap, billed: feature.billed, promised }
    : null;
};

/**
 * May this amount be recorded now?
 *
 * One order, the order every write path already applied: the standing, the
 * quantity ceiling, the money ceiling, and the count or pool the feature
 * spends. A credit-priced feature is judged against the shared pool, a counted
 * one against its own `remaining`, and a flag or an unlimited allowance never
 * runs out — so it is `Allowed` however large the ask is.
 *
 * The ceiling is written from `remaining`, the way a read model knows it:
 * `remaining` already has use and holds taken out, and `carried` is the extra
 * `included` a rollover added, which a cap does not grow with. An allowance
 * that grants the feature nothing is a blocking one with `remaining: 0`, so it
 * needs no separate tag.
 *
 * ### Asking before writing
 * **Example:** Judge one message against a standing
 * ```typescript
 * capacityOf({
 *   standing: "good",
 *   feature: {
 *     overage: "block",
 *     included: 100,
 *     used: 40,
 *     reserved: 0,
 *     billed: 0,
 *     remaining: 60,
 *   },
 *   ask: { amount: 25 },
 * });
 * // { _tag: "Allowed" }
 * ```
 *
 */
export const capacityOf = (input: {
  readonly standing: Standing;
  readonly feature: JudgedFeature;
  readonly ask: Ask;
}): Capacity => {
  const { standing, feature, ask } = input;
  if (standing === "blocked") return { _tag: "Standing", standing };
  const amount = ask.amount;
  // A quantity is bought, not spent: its ceiling is the cap, and the free grant
  // is a price boundary rather than a count that runs out.
  if (feature.quantity !== undefined) {
    if (feature.cap === undefined) return { _tag: "Allowed" };
    const headroom = feature.cap - feature.quantity;
    return amount > headroom
      ? { _tag: "Ceiling", cap: feature.cap, headroom, requested: amount }
      : { _tag: "Allowed" };
  }
  // A credit-priced feature spends the shared pool: its `remaining` is the pool
  // less every open hold, and one unit costs its card's rate. Its `included` is
  // `null`, so the counted rules below do not apply.
  if (feature.creditRates !== undefined) {
    const cost = amount * creditRateOf(feature.creditRates, ask);
    const available = feature.remaining ?? 0;
    return cost > available ? { _tag: "Credits", cost, available } : { _tag: "Allowed" };
  }
  // A cap is the ceiling, not the standing: at it the account is out of what it
  // bought, so this refuses while `standing` stays `good`.
  if (feature.cap !== undefined && feature.remaining !== null) {
    const headroom = feature.remaining + feature.cap - (feature.carried ?? 0);
    if (amount > headroom) {
      return { _tag: "Ceiling", cap: feature.cap, headroom, requested: amount };
    }
  }
  const money = moneyOverflowOf(feature, amount);
  if (money !== null) return { _tag: "Money", ...money };
  // A `null` remaining is an allowance that never runs out, and a flag is
  // granted rather than spent: neither has a count to run past.
  if (feature.overage === "block" && feature.remaining !== null && amount > feature.remaining) {
    return { _tag: "Remaining", requested: amount, remaining: feature.remaining };
  }
  return { _tag: "Allowed" };
};

/**
 * The counters a move below an allowance is judged against: what the period
 * already used, what open holds still owe, and what it already billed.
 */
export interface ChangeCounters {
  readonly used: number;
  readonly reserved: number;
  readonly billed: number;
}

/**
 * Is the standing already past what this allowance permits?
 *
 * The other question a tier change asks, and not the capacity question: a move
 * is refused only when the new allowance is already below the period — the
 * blocking count, the unit ceiling, or the money already billed. A billed or
 * allowed allowance is never refused for being past `included`: being past it
 * is the state those overages exist for.
 */
export type Downgrade =
  | { readonly _tag: "Allowed" }
  /** The new allowance's blocking count is below `used + reserved`. */
  | {
      readonly _tag: "Usage";
      /** The new tier's included amount, which the usage exceeds. */
      readonly included: number;
      readonly used: number;
      /** Units open holds still owe; absent when nothing is held. */
      readonly reserved?: number;
    }
  /** The new money ceiling is below what the period already billed. */
  | { readonly _tag: "Spend"; readonly moneyCap: number; readonly billed: number }
  /** The new unit ceiling (`included + cap`) is below `used + reserved`. */
  | {
      readonly _tag: "Ceiling";
      /** The new tier's ceiling: `included + cap`. */
      readonly ceiling: number;
      readonly used: number;
      /** Units open holds still owe; absent when nothing is held. */
      readonly reserved?: number;
    };

/**
 * Would a move to this allowance leave the standing below what the period
 * already consumed?
 *
 * `ChangeTier` reports the variant as `DowngradeBelow*`, and `actionsFor` uses
 * the same answer to decide which tiers the console may offer, so a button can
 * never be shown for a move the model would refuse.
 *
 * ### Offering only a move the model accepts
 * **Example:** A tier whose cap the period already passed is not offered
 * ```typescript
 * downgradeOf(
 *   { included: 100, overage: "bill", cap: 20 },
 *   { used: 130, reserved: 0, billed: 0 },
 * );
 * // { _tag: "Ceiling", ceiling: 120, used: 130 }
 * ```
 *
 */
export const downgradeOf = (
  allowance: {
    readonly included: Included;
    readonly overage: Overage;
    readonly cap?: number;
    readonly moneyCap?: number;
  },
  counters: ChangeCounters,
): Downgrade => {
  const { used, reserved, billed } = counters;
  if (
    allowance.overage === "block" &&
    allowance.included !== "unlimited" &&
    used + reserved > allowance.included
  ) {
    return {
      _tag: "Usage",
      included: allowance.included,
      used,
      ...(reserved === 0 ? {} : { reserved }),
    };
  }
  if (allowance.moneyCap !== undefined && billed > allowance.moneyCap) {
    return { _tag: "Spend", moneyCap: allowance.moneyCap, billed };
  }
  const ceiling = spendCeilingOf(allowance);
  if (ceiling !== null && used + reserved > ceiling) {
    return {
      _tag: "Ceiling",
      ceiling,
      used,
      ...(reserved === 0 ? {} : { reserved }),
    };
  }
  return { _tag: "Allowed" };
};
