import * as Schema from "effect/Schema";
import { FeatureId, type Feature } from "./Feature.ts";

/** What happens when a feature is used past its included amount. */
export const Overage = Schema.Literals(["block", "bill", "allow"]);
export type Overage = typeof Overage.Type;

/** When an allowance returns to its included amount. */
export const Resets = Schema.Literals(["month", "annual", "never"]);
export type Resets = typeof Resets.Type;

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
export const AllowanceKind = Schema.Literals(["metered", "flag"]);
export type AllowanceKind = typeof AllowanceKind.Type;

/**
 * The money one billable unit costs: integer minor units and one currency.
 * Unlike {@link Price} it has no interval — a postpaid unit is charged once,
 * not on a cadence.
 */
export const UnitPrice = Schema.Struct({
  amount: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  currency: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});
export type UnitPrice = typeof UnitPrice.Type;

/**
 * The identity of a unit price in a log or a read model. Two prices are the
 * same price exactly when this is, so a mid-period change — an amount, or a
 * currency — is a different key and the close reports the units separately.
 */
export const unitPriceKey = (unitPrice: UnitPrice): string =>
  `${unitPrice.currency}:${unitPrice.amount}`;

/**
 * What a tier grants of one feature, and what happens past it. `included` is a
 * count in the feature's own unit; `unitPrice` is what a billable unit past it
 * costs, and `moneyCap` is the money ceiling for one period. `carryOver` says
 * what happens to the part a period did not spend.
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
  resets: Resets,
  /**
   * Whether the part a period did not spend carries into the next one, capped
   * at `included`. Absent means `false`: the next period starts at `included`.
   */
  carryOver: Schema.optionalKey(Schema.Boolean),
  /**
   * The most a period may bill *past* `included`, in the feature's own units:
   * `included + cap` is the ceiling. Only meaningful with `overage: "bill"`,
   * which the catalog enforces. Absent means no ceiling.
   */
  cap: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
  /**
   * What one unit past `included` costs, in minor units. Requires
   * `overage: "bill"`; the catalog enforces it. Absent means usage is counted
   * or blocked, never priced here.
   */
  unitPrice: Schema.optionalKey(UnitPrice),
  /**
   * The most money a period may bill for this feature, in minor units. Requires
   * `unitPrice`; a money ceiling needs a unit price to compute. Absent means no
   * money ceiling.
   */
  moneyCap: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
});
export type Allowance = typeof Allowance.Type;

/** Every feature's allowance in a tier, keyed by feature id. */
export const Allowances = Schema.Record(Schema.String, Allowance);
export type Allowances = typeof Allowances.Type;

/** The fields every allowance shape shares. */
interface AllowanceBase {
  /** @default "month" */
  readonly resets?: Resets;
  /**
   * Carry what a period did not spend into the next one, at most `included`.
   * Refused on a `"flag"` and on `resets: "never"`.
   * @default false
   */
  readonly carryOver?: boolean;
}

/** An allowance that never runs out; there is nothing past its end. */
interface UnlimitedAllowanceInput extends AllowanceBase {
  readonly included: "unlimited";
  /** @default "allow" */
  readonly overage?: "allow";
  readonly cap?: never;
  readonly unitPrice?: never;
  readonly moneyCap?: never;
}

/** A count that blocks or allows past its end; nothing is billed. */
interface UnbilledAllowanceInput extends AllowanceBase {
  readonly included: number;
  /** @default "block" */
  readonly overage?: "block" | "allow";
  readonly cap?: never;
  readonly unitPrice?: never;
  readonly moneyCap?: never;
}

/** A billed count with a unit cap, and no unit price yet. */
interface BilledUnitsAllowanceInput extends AllowanceBase {
  readonly included: number;
  readonly overage: "bill";
  /** The most units a period may bill past `included`. */
  readonly cap?: number;
  /** What one billed unit costs. Without it the units are counted, not priced. */
  readonly unitPrice?: UnitPrice;
  readonly moneyCap?: never;
}

/** A billed count with a unit price, and optionally a money ceiling. */
interface BilledMoneyAllowanceInput extends AllowanceBase {
  readonly included: number;
  readonly overage: "bill";
  readonly cap?: number;
  readonly unitPrice: UnitPrice;
  /** The most money this feature may bill in one period, in minor units. */
  readonly moneyCap?: number;
}

/**
 * The part of an allowance an author chooses; the rest has a default.
 *
 * The shape is a union, not one interface with optional fields: a cap, a unit
 * price or a money cap describes a bill, so it is only representable with
 * `overage: "bill"`, and `"unlimited"` can only allow. The catalog still
 * validates the serialized form; this makes the same contradiction an editor
 * error for a TypeScript author.
 */
export type AllowanceInput =
  | UnlimitedAllowanceInput
  | UnbilledAllowanceInput
  | BilledUnitsAllowanceInput
  | BilledMoneyAllowanceInput;

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
 * // Rollover: what this period did not spend carries into the next one, at
 * // most one period's worth.
 * allowance(messages, { included: 2_000, carryOver: true });
 *
 * // A ceiling: bill up to 10,000 units past the 2,000 included this period,
 * // then refuse until it resets. A cap needs `overage: "bill"`.
 * allowance(messages, { included: 2_000, overage: "bill", cap: 10_000 });
 * // { feature: "messages", kind: "metered", included: 2_000, overage: "bill", resets: "month", carryOver: false, cap: 10_000 }
 *
 * // Postpaid: $0.002 a call past the included 2,000, and no more than $50 of
 * // overage in a period.
 * allowance(messages, {
 *   included: 2_000,
 *   overage: "bill",
 *   unitPrice: { amount: 2, currency: "usd" },
 *   moneyCap: 5_000,
 * });
 *
 * // Unlimited: past the end of an allowance that never runs out there is
 * // nothing to block or to bill, so `overage` defaults to "allow".
 * allowance(messages, { included: "unlimited" });
 * // { feature: "messages", kind: "metered", included: "unlimited", overage: "allow", resets: "month", carryOver: false }
 * ```
 */
type Metered<F extends Feature> = "metered" extends F["kind"]
  ? F
  : F["kind"] extends "flag"
    ? never
    : F;

type Flag<F extends Feature> = "flag" extends F["kind"] ? F : F["kind"] extends "flag" ? F : never;

export const allowance = <F extends Feature>(
  feature: Metered<F>,
  input: AllowanceInput,
): Allowance => ({
  feature: feature.id,
  kind: "metered",
  included: input.included,
  overage: input.overage ?? (input.included === "unlimited" ? "allow" : "block"),
  resets: input.resets ?? "month",
  carryOver: input.carryOver ?? false,
  ...(input.cap === undefined ? {} : { cap: input.cap }),
  ...(input.unitPrice === undefined ? {} : { unitPrice: { ...input.unitPrice } }),
  ...(input.moneyCap === undefined ? {} : { moneyCap: input.moneyCap }),
});

/**
 * Whether an allowance is a flag's grant rather than a count. Read off `kind`,
 * never off the numbers: a metered allowance of one unit that never resets is a
 * legitimate allowance, and treating it as a flag would refuse its usage.
 */
export const isFlagGrant = (allowance: { readonly kind?: AllowanceKind }): boolean =>
  allowance.kind === "flag";

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
