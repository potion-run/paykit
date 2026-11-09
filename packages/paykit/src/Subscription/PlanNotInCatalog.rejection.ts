import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/** A command names a tier the catalog does not have. */
export class PlanNotInCatalog extends Domain.Rejection("PlanNotInCatalog", {
  tier: Schema.String,
}) {}
