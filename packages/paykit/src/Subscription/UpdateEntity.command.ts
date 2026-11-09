import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Session } from "../Auth/Guards.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { EntityId } from "../Customer.ts";
import { EntityArchived } from "./EntityArchived.rejection.ts";
import { EntityUnknown } from "./EntityUnknown.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * An entity's name changed. A write with the name it already holds records
 * nothing, so a rename is idempotent without relying on the command id.
 */
export class EntityUpdated extends Domain.Event("EntityUpdated", {
  entity: EntityId,
  name: Schema.optionalKey(Schema.String),
}) {}

/**
 * Rename an entity, or clear its name. It moves no balance and no plan: the
 * scope, its sources and its history are what they were (ADR 0040 §7).
 *
 * An archived entity refuses the write; renaming is not a way to reopen one.
 *
 * ### Renaming a scope
 * **Example:** The label a console shows
 * ```typescript
 * const entities = yield* Paykit.Entities(account);
 * yield* entities.update({ entityId: "ent_support", name: "Support EU", idempotencyKey: "rename-1" });
 * ```
 *
 * @binding
 * @product Entities
 * @provides Paykit.Entities
 */
export class UpdateEntity extends Domain.Command("UpdateEntity", {
  target: AccountId,
  input: {
    entityId: EntityId,
    name: Schema.optionalKey(Schema.String),
  },
  events: [EntityUpdated],
  rejects: [EntityUnknown, EntityArchived, Forbidden, Unauthenticated],
  middleware: [Session],
}) {}
