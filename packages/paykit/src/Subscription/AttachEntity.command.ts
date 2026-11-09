import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Session } from "../Auth/Guards.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { EntityId } from "../Customer.ts";
import { EntityArchived } from "./EntityArchived.rejection.ts";
import { EntityExists } from "./EntityExists.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * A child scope was created under the customer. `plans`, `remaining` and every
 * other count start empty: a scope holds nothing until a plan is attached to it,
 * and a pooled item is attached on the customer, never here (ADR 0040 §3).
 */
export class EntityAttached extends Domain.Event("EntityAttached", {
  entity: EntityId,
  name: Schema.optionalKey(Schema.String),
  at: Schema.DateTimeUtc,
}) {}

/**
 * Create an entity under a customer. The customer is the only writer: this is a
 * command on the customer's aggregate and `entityId` is command data, not a
 * second account (ADR 0040 §2).
 *
 * The id is the command id, so a retry with the same id is a replay rather than
 * a second create. A predefined id is what every caller supplies: an entity is
 * named by the deployment, so a restored state reconciles to the same scope.
 *
 * ### Creating a scope, then attaching a plan to it
 * **Example:** A support team with its own plan
 * ```typescript
 * const entities = yield* Paykit.Entities(account);
 * yield* entities.create({ entityId: Paykit.EntityId.make("ent_support"), name: "Support" });
 *
 * const attach = yield* Paykit.Attach(account);
 * yield* attach({ entityId: Paykit.EntityId.make("ent_support"), planId: "team", idempotencyKey: "attach-team-1" });
 * ```
 *
 * @binding
 * @product Entities
 * @provides Paykit.Entities
 */
export class AttachEntity extends Domain.Command("AttachEntity", {
  target: AccountId,
  input: {
    entityId: EntityId,
    name: Schema.optionalKey(Schema.String),
  },
  events: [EntityAttached],
  rejects: [EntityExists, EntityArchived, Forbidden, Unauthenticated],
  middleware: [Session],
}) {}
