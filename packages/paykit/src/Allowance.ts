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
 * What a tier grants of one feature, and what happens past it. `included`
 * is a count, never money: money on a feature lives in the provider's price
 * mapping, never in the catalog.
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
});
export type Allowance = typeof Allowance.Type;

/** Every feature's allowance in a tier, keyed by feature id. */
export const Allowances = Schema.Record(Schema.String, Allowance);
export type Allowances = typeof Allowances.Type;

/** The part of an allowance an author chooses; the rest has a default. */
export interface AllowanceInput {
  /** A count, or `"unlimited"` for one that never runs out. */
  readonly included: Included;
  /**
   * @default "allow" when `included` is `"unlimited"`, `"block"` otherwise
   */
  readonly overage?: Overage;
  /** @default "month" */
  readonly resets?: Resets;
}

/**
 * Quote a declared feature in a tier. Taking the `Feature` value rather than
 * its id is what keeps a tier's grants tied to a declared feature.
 *
 * ### Writing an allowance
 * **Example:** Defaults, then an explicit overage and reset
 * ```typescript
 * allowance(messages, { included: 100 });
 * // { feature: "messages", included: 100, overage: "block", resets: "month" }
 *
 * allowance(messages, { included: 2_000, overage: "bill" });
 * allowance(seats, { included: 5, resets: "never" });
 *
 * // Unlimited: past the end of an allowance that never runs out there is
 * // nothing to block or to bill, so `overage` defaults to "allow".
 * allowance(messages, { included: "unlimited" });
 * // { feature: "messages", included: "unlimited", overage: "allow", resets: "month" }
 * ```
 */
export const allowance = (feature: Feature, input: AllowanceInput): Allowance => ({
  feature: feature.id,
  kind: "metered",
  included: input.included,
  overage: input.overage ?? (input.included === "unlimited" ? "allow" : "block"),
  resets: input.resets ?? "month",
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
export const grant = (feature: Feature): Allowance => ({
  feature: feature.id,
  kind: "flag",
  included: 1,
  overage: "allow",
  resets: "never",
});
