import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { EntityId } from "../Customer.ts";

/**
 * An entity cannot be archived while anyone still occupies one of its seats.
 * Evicting a user is never a billing side effect: an operator sets occupancy to
 * zero with `SetUsage`, then archives (ADR 0036, ADR 0040 §7).
 */
export class EntityHasOccupancy extends Domain.Rejection("EntityHasOccupancy", {
  entityId: EntityId,
  /** Every feature still occupied, with the count in use. */
  occupancy: Schema.Array(
    Schema.Struct({
      featureId: Schema.String,
      occupied: Schema.Int,
    }),
  ),
}) {}
