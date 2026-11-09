import * as Domain from "@alchemy.run/domain";
import { EntityId } from "../Customer.ts";

/**
 * An entity with this id already exists under the customer. An id is never
 * reused, so attaching it again is not a rename: `UpdateEntity` is the verb for
 * that, and a new entity is a new id (ADR 0040 §7).
 */
export class EntityExists extends Domain.Rejection("EntityExists", {
  entityId: EntityId,
}) {}
