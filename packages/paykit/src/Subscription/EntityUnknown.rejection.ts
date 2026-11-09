import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { EntityId } from "../Customer.ts";

/**
 * The command names an entity this customer never attached. A writable entity is
 * created first: an id that does not exist is not a detached scope to adopt, and
 * an id from another customer is indistinguishable from one that never existed
 * (ADR 0040 §1–2).
 */
export class EntityUnknown extends Domain.Rejection("EntityUnknown", {
  account: Schema.String,
  entityId: EntityId,
}) {}
