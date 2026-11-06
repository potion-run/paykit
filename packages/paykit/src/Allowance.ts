import * as Schema from "effect/Schema";
import { FeatureId, type Feature } from "./Feature.ts";
import { Pricing, UnitPrice, pricing as makePricing, type PricingInput } from "./Pricing.ts";

export { UnitPrice, priceKey as unitPriceKey } from "./Pricing.ts";
export type { PriceBand, Pricing, PricingInput } from "./Pricing.ts";

/** What happens when a feature is used past its included amount. */
export const Overage = Schema.Literals(["block", "bill", "allow"]);
export type Overage = typeof Overage.Type;

/**
 * How often an allowance returns to its included amount. `month` and `annual`
 * follow the standing's period; every shorter interval is its own window, so a
 * monthly plan can grant a daily allowance without waiting for the period.
 */
export const Resets = Schema.Literals([
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "semi_annual",
  "annual",
  "never",
]);
export type Resets = typeof Resets.Type;

/**
 * How a quantity change is billed. `immediate` prorates the difference for the
 * rest of the period; `period_end` records the new quantity and lets the next
 * period bill it in full. Only a non-consumable allowance states one.
 */
export const Prorate = Schema.Literals(["immediate", "period_end"]);
export type Prorate = typeof Prorate.Type;

/** How many intervals a reset schedule waits between boundaries. Defaults to one. */
export const ResetEvery = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)));
export type ResetEvery = typeof ResetEvery.Type;

/**
 * How much a tier includes of one feature: a count, or an allowance that never
 * runs out. `"unlimited"` is not a large number — it is the absence of a
 * count, which is why a read model reports it as `remaining: null` and why an
 * unlimited allowance cannot also say what happens past its end.
 */
export const Included = Schema.Union([
  Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  Schema.Literal("unlimited"),
]);
export type Included = typeof Included.Type;

/**
 * Whether an allowance is counted, or an on/off grant. It lives on the
 * allowance and not only on the feature because `decide` is pure and never sees
 * the catalog: a command carries allowances, so the allowance has to say what
 * kind of thing it is.
 */
export const AllowanceKind = Schema.Literals(["metered", "flag", "non_consumable"]);
export type AllowanceKind = typeof AllowanceKind.Type;

/**
 * What a tier grants of one feature, and what happens past it. `included` is a
 * count in the feature's own unit; `pricing` is how a billable unit past it is
 * priced, and `moneyCap` is the money ceiling for one window. `carryOver` says
 * what happens to the part a window did not spend.
 */
export const Allowance = Schema.Struct({
  feature: FeatureId,
  /**
   * Absent means `metered`: allowances recorded before the field existed are
   * counted by construction, so old state and old events still decode.
   */
  kind: Schema.optionalKey(AllowanceKind),
  included: Included,
  overage: Overage,
  /** When the allowance returns to `included`. */
  resets: Resets,
  /**
   * How many `resets` intervals between boundaries. Absent means one: a
   * `resets: "day"` allowance resets every day, and `resetEvery: 4` every four.
   * Refused on `"never"`, which has no boundary.
   */
  resetEvery: Schema.optionalKey(ResetEvery),
  /**
   * Whether the part a window did not spend carries into the next one, capped
   * at `included`. Absent means `false`: the next window starts at `included`.
   */
  carryOver: Schema.optionalKey(Schema.Boolean),
  /**
   * The most an allowance may carry into one window, in the feature's own
   * units. Requires `carryOver`. Absent means `included`, the existing cap.
   */
  carryCap: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
  /**
   * The most a window may bill *past* `included`, in the feature's own units:
   * `included + cap` is the ceiling. On a non-consumable allowance it is the
   * maximum quantity instead. Only meaningful with `overage: "bill"`, which the
   * catalog enforces. Absent means no ceiling.
   */
  cap: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
  /**
   * How a quantity change is billed. Only a non-consumable allowance states
   * one; `immediate` prorates the difference for the rest of the period.
   */
  prorate: Schema.optionalKey(Prorate),
  /**
   * How a billable unit is priced: one rate, graduated bands, or volume bands.
   * Requires `overage: "bill"`; the catalog enforces it. Absent means usage is
   * counted or blocked, never priced here.
   */
  pricing: Schema.optionalKey(Pricing),
  /**
   * The one-rate form of {@link pricing}. Kept as a shorthand for the common
   * case and for state recorded before `pricing` existed; {@link pricingOf}
   * reads either, so no caller has to know which one a standing carries.
   */
  unitPrice: Schema.optionalKey(UnitPrice),
  /**
   * The most money a window may bill for this feature, in minor units.
   * Requires a price; a money ceiling needs one to compute. Absent means no
   * money ceiling.
   */
  moneyCap: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
});
export type Allowance = typeof Allowance.Type;

/** Every feature's allowance in a tier, keyed by feature id. */
export const Allowances = Schema.Record(Schema.String, Allowance);
export type Allowances = typeof Allowances.Type;

/**
 * The pricing an allowance bills with, or `null` when it bills nothing. The
 * one-rate shorthand and the general form answer the same question, so every
 * caller reads this instead of the two fields.
 */
export const pricingOf = (allowance: {
  readonly pricing?: Pricing;
  readonly unitPrice?: UnitPrice;
}): Pricing | null =>
  allowance.pricing ??
  (allowance.unitPrice === undefined ? null : { _tag: "unit", unitPrice: allowance.unitPrice });

/** Whether an allowance is a flag's grant rather than a count. */
export const isFlagGrant = (allowance: { readonly kind?: AllowanceKind }): boolean =>
  allowance.kind === "flag";

/** Whether an allowance is a quantity that is set rather than spent. */
export const isQuantityGrant = (allowance: { readonly kind?: AllowanceKind }): boolean =>
  allowance.kind === "non_consumable";

/** How many intervals one reset window spans. */
export const resetEveryOf = (allowance: { readonly resetEvery?: number }): number =>
  allowance.resetEvery ?? 1;

/** The most an allowance may carry into one window, or `null` for no carry. */
export const carryCapOf = (allowance: {
  readonly carryOver?: boolean;
  readonly carryCap?: number;
  readonly included?: Included;
}): number | null => {
  if (allowance.carryOver !== true) return null;
  if (allowance.carryCap !== undefined) return allowance.carryCap;
  return typeof allowance.included === "number" ? allowance.included : null;
};

/** The fields every allowance shape shares. */
interface AllowanceBase {
  /** How a quantity change is billed. Only a non-consumable allowance states one. */
  readonly prorate?: Prorate;
  /** @default "month" */
  readonly resets?: Resets;
  /**
   * How many `resets` intervals between boundaries. `resetEvery: 4` beside
   * `resets: "day"` is a four-hour allowance. Refused on `"never"`.
   * @default 1
   */
  readonly resetEvery?: number;
  /**
   * Carry what a window did not spend into the next one, at most `included`.
   * Refused on a `"flag"` and on `resets: "never"`.
   * @default false
   */
  readonly carryOver?: boolean;
  /** The most one window may carry, in the feature's own units. Requires `carryOver`. */
  readonly carryCap?: number;
}

/** An allowance that never runs out; there is nothing past its end. */
interface UnlimitedAllowanceInput extends AllowanceBase {
  readonly included: "unlimited";
  /** @default "allow" */
  readonly overage?: "allow";
  readonly cap?: never;
  readonly pricing?: never;
  readonly unitPrice?: never;
  readonly moneyCap?: never;
}

/** A count that blocks or allows past its end; nothing is billed. */
interface UnbilledAllowanceInput extends AllowanceBase {
  readonly included: number;
  /** @default "block" */
  readonly overage?: "block" | "allow";
  readonly cap?: never;
  readonly pricing?: never;
  readonly unitPrice?: never;
  readonly moneyCap?: never;
}

/** A billed count with a unit cap, and no price yet. */
interface BilledUnitsAllowanceInput extends AllowanceBase {
  readonly included: number;
  readonly overage: "bill";
  /** The most units a window may bill past `included`. */
  readonly cap?: number;
  /** What one billed unit costs. Without it the units are counted, not priced. */
  readonly unitPrice?: UnitPrice;
  readonly pricing?: never;
  readonly moneyCap?: never;
}

/** A billed count with a one-rate price, and optionally a money ceiling. */
interface BilledMoneyAllowanceInput extends AllowanceBase {
  readonly included: number;
  readonly overage: "bill";
  readonly cap?: number;
  readonly unitPrice: UnitPrice;
  readonly pricing?: never;
  /** The most money this feature may bill in one window, in minor units. */
  readonly moneyCap?: number;
}

/**
 * A quantity as an author writes it: a free grant, a cap and, when additional
 * units are billed, one unit price. A quantity never resets and never carries.
 */
export interface QuantityAllowanceInput extends AllowanceBase {
  readonly included: number;
  /** @default "block" */
  readonly overage?: "block" | "allow" | "bill";
  /** The most the quantity may reach, including the free grant. */
  readonly cap?: number;
  /** What one additional unit costs per period. */
  readonly pricing?: PricingInput;
  readonly unitPrice?: UnitPrice;
  readonly moneyCap?: never;
  readonly resets?: "never";
}

/** A billed count priced by bands, and optionally a money ceiling. */
interface BilledPricedAllowanceInput extends AllowanceBase {
  readonly included: number;
  readonly overage: "bill";
  readonly cap?: number;
  /** One rate, graduated bands, or volume bands. */
  readonly pricing: PricingInput;
  readonly unitPrice?: never;
  /** The most money this feature may bill in one window, in minor units. */
  readonly moneyCap?: number;
}

/**
 * The part of an allowance an author chooses; the rest has a default.
 *
 * The shape is a union, not one interface with optional fields: a cap, a price
 * or a money cap describes a bill, so it is only representable with
 * `overage: "bill"`, and `"unlimited"` can only allow. The catalog still
 * validates the serialized form; this makes the same contradiction an editor
 * error for a TypeScript author.
 */
export type AllowanceInput =
  | UnlimitedAllowanceInput
  | UnbilledAllowanceInput
  | BilledUnitsAllowanceInput
  | BilledMoneyAllowanceInput
  | BilledPricedAllowanceInput;

/**
 * Quote a declared feature in a tier. Taking the `Feature` value rather than
 * its id is what keeps a tier's grants tied to a declared feature.
 *
 * ### Writing an allowance
 * **Example:** Defaults, then an explicit overage and reset
 * ```typescript
 * allowance(messages, { included: 100 });
 * // { feature: "messages", kind: "metered", included: 100, overage: "block", resets: "month", carryOver: false }
 *
 * allowance(messages, { included: 2_000, overage: "bill" });
 * allowance(seats, { included: 5, resets: "never" });
 *
 * // Rollover: what this window did not spend carries into the next one, at
 * // most `included` (or `carryCap`).
 * allowance(messages, { included: 2_000, carryOver: true, carryCap: 5_000 });
 *
 * // A daily allowance on a monthly plan, resetting every four hours.
 * allowance(messages, { included: 50, resets: "day" });
 * allowance(messages, { included: 10, resets: "hour", resetEvery: 4 });
 *
 * // A ceiling: bill up to 10,000 units past the 2,000 included this window,
 * // then refuse until it resets. A cap needs `overage: "bill"`.
 * allowance(messages, { included: 2_000, overage: "bill", cap: 10_000 });
 *
 * // Postpaid: $0.002 a call past the included 2,000, and no more than $50 of
 * // overage in a window.
 * allowance(messages, {
 *   included: 2_000,
 *   overage: "bill",
 *   unitPrice: { amount: 2, currency: "usd" },
 *   moneyCap: 5_000,
 * });
 *
 * // $5 for each 1,000 calls, with a money ceiling.
 * allowance(messages, {
 *   included: 2_000,
 *   overage: "bill",
 *   pricing: { kind: "unit", amount: 500, currency: "usd", units: 1_000 },
 *   moneyCap: 5_000,
 * });
 *
 * // The first 10,000 calls at $0.01, then $0.005.
 * allowance(messages, {
 *   included: 2_000,
 *   overage: "bill",
 *   pricing: {
 *     kind: "graduated",
 *     currency: "usd",
 *     bands: [
 *       { upTo: 10_000, amount: 1, currency: "usd" },
 *       { upTo: "inf", amount: 5, currency: "usd", units: 1_000 },
 *     ],
 *   },
 * });
 *
 * // Unlimited: past the end of an allowance that never runs out there is
 * // nothing to block or to bill, so `overage` defaults to "allow".
 * allowance(messages, { included: "unlimited" });
 * // { feature: "messages", kind: "metered", included: "unlimited", overage: "allow", resets: "month", carryOver: false }
 * ```
 */
type Metered<F extends Feature> = F["kind"] extends "flag" | "non_consumable" ? never : F;

type Quantity<F extends Feature> = F["kind"] extends "non_consumable" ? F : never;

type Flag<F extends Feature> = "flag" extends F["kind"] ? F : F["kind"] extends "flag" ? F : never;

/** Quote a declared non-consumable feature: a quantity, set rather than spent. */
export function allowance<F extends Feature>(
  feature: Quantity<F>,
  input: QuantityAllowanceInput,
): Allowance;
/** Quote a declared metered feature in a tier. */
export function allowance<F extends Feature>(feature: Metered<F>, input: AllowanceInput): Allowance;
export function allowance(
  feature: Feature,
  input: AllowanceInput | QuantityAllowanceInput,
): Allowance {
  const kind = feature.kind === "non_consumable" ? "non_consumable" : "metered";
  const value = input as AllowanceInput & QuantityAllowanceInput;
  const included = value.included as Included;
  return {
    feature: feature.id,
    kind,
    included,
    overage: value.overage ?? (included === "unlimited" ? "allow" : "block"),
    resets: kind === "non_consumable" ? "never" : (value.resets ?? "month"),
    ...(value.resetEvery === undefined ? {} : { resetEvery: value.resetEvery }),
    carryOver: value.carryOver ?? false,
    ...(value.carryCap === undefined ? {} : { carryCap: value.carryCap }),
    ...(value.cap === undefined ? {} : { cap: value.cap }),
    ...(value.pricing === undefined ? {} : { pricing: makePricing(value.pricing) }),
    ...(value.unitPrice === undefined ? {} : { unitPrice: { ...value.unitPrice } }),
    ...(value.moneyCap === undefined ? {} : { moneyCap: value.moneyCap }),
    ...(value.prorate === undefined ? {} : { prorate: value.prorate }),
  };
}

/**
 * Grant a declared flag in a tier: "this tier has it", with no count to spend.
 * The result is a normal {@link Allowance}, so a tier, a command and the read
 * model carry it without learning a second shape.
 *
 * ### Granting an on/off feature
 * **Example:** SSO on an enterprise tier
 * ```typescript
 * const sso = feature({ id: "sso", name: "SSO", kind: "flag" });
 *
 * grant(sso);
 * // { feature: "sso", kind: "flag", included: 1, overage: "allow", resets: "never" }
 * ```
 */
export const grant = <F extends Feature>(feature: Flag<F>): Allowance => ({
  feature: feature.id,
  kind: "flag",
  included: 1,
  overage: "allow",
  resets: "never",
});
