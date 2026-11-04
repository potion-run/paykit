import * as Schema from "effect/Schema";
import { FeatureId, type Feature } from "./Feature.ts";

/** What happens when a feature is used past its included amount. */
export const Overage = Schema.Literals(["block", "bill", "allow"]);
export type Overage = typeof Overage.Type;

/** When an allowance returns to its included amount. */
export const Resets = Schema.Literals(["month", "annual", "never"]);
export type Resets = typeof Resets.Type;

/**
 * What a tier grants of one feature, and what happens past it. `included`
 * is a count, never money: money on a feature lives in the provider's price
 * mapping, never in the catalog.
 */
export const Allowance = Schema.Struct({
  feature: FeatureId,
  included: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  overage: Overage,
  resets: Resets,
});
export type Allowance = typeof Allowance.Type;

/** Every feature's allowance in a tier, keyed by feature id. */
export const Allowances = Schema.Record(Schema.String, Allowance);
export type Allowances = typeof Allowances.Type;

/** The part of an allowance an author chooses; the rest has a default. */
export interface AllowanceInput {
  readonly included: number;
  /** @default "block" */
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
 * ```
 */
export const allowance = (feature: Feature, input: AllowanceInput): Allowance => ({
  feature: feature.id,
  included: input.included,
  overage: input.overage ?? "block",
  resets: input.resets ?? "month",
});
