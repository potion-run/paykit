import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * The feature is priced in credits, so it has no count of its own to grant or
 * scope: credits are one pool per customer (ADR 0002). An entity reaches them
 * through a pooled plan item, never through a grant or a transfer.
 */
export class FeaturePricedInCredits extends Domain.Rejection("FeaturePricedInCredits", {
  feature: Schema.String,
}) {}
