import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * The feature is not a quantity. A non-consumable is set with `SetQuantity`;
 * a metered feature is tracked and a flag is granted, so neither has a
 * quantity to set.
 */
export class FeatureNotConsumable extends Domain.Rejection("FeatureNotConsumable", {
  feature: Schema.String,
}) {}
