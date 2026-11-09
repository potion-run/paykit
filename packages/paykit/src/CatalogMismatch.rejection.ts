import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * A command carried catalog-derived fields that disagree with the catalog the
 * deployment validates: a tier that does not exist, allowances the tier does
 * not grant, or a price the tier does not charge.
 *
 * This is a refusal, not a correction. Silently rewriting the caller's input
 * would let a bug in a client become a wrong invoice, and `decide` cannot
 * repair it because it is pure and has no catalog.
 */
export class CatalogMismatch extends Domain.Rejection("CatalogMismatch", {
  /** The tier the command named, when the disagreement is about a plan. */
  tier: Schema.optionalKey(Schema.String),
  /** The feature the command named, when the disagreement is about a control. */
  feature: Schema.optionalKey(Schema.String),
  /** Which field disagreed: `tier`, `allowances`, `price`, `topUp`, `rates` or `features`. */
  field: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}
