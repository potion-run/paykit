import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Session } from "../Auth/Guards.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { EntityId } from "../Customer.ts";
import { EntityArchived } from "./EntityArchived.rejection.ts";
import { EntityHasOccupancy } from "./EntityHasOccupancy.rejection.ts";
import { EntityUnknown } from "./EntityUnknown.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * The units a scope owned, by feature and by class, that the archive moved to
 * the customer: a plan and a rollover source as `plan`, a standalone grant as
 * `grant` with its interval and deadline. Nothing is destroyed — the sweep is
 * the record of what left the scope, so replay rebuilds both balances (ADR 0003,
 * ADR 0040 §7).
 */
export const ReturnedSource = Schema.Struct({
  feature: Schema.String,
  /** The class of source that moved; a lifetime grant keeps its class. */
  kind: Schema.Literals(["plan", "rollover", "grant"]),
  amount: Schema.Int,
  /** The reset interval the source ran on: `never` for a lifetime grant. */
  interval: Schema.String,
  /** The deadline the source carried, when it had one. */
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
  /** The grant's id, when the source was a standalone grant, so it stays one. */
  grantId: Schema.optionalKey(Schema.String),
});

export type ReturnedSource = typeof ReturnedSource.Type;

/** A purchase that carried no occupancy moves to the customer; no money moves. */
export const ReturnedQuantity = Schema.Struct({
  feature: Schema.String,
  quantity: Schema.Int,
});

export type ReturnedQuantity = typeof ReturnedQuantity.Type;

/**
 * An entity was archived. The event is the only record of the sweep: `returned`
 * is what moved to the customer's sources and `returnedQuantities` what moved of
 * a purchase nobody occupied. The entity's record stays, holding nothing, and
 * its history and bills are retained (ADR 0003, ADR 0040 §7).
 *
 * The serialized tag is `EntityArchived`, as the ADR names it. The class is
 * `EntityArchivedEvent` because the refusal below owns the plain identifier.
 */
export class EntityArchivedEvent extends Domain.Event("EntityArchived", {
  entity: EntityId,
  at: Schema.DateTimeUtc,
  returned: Schema.Array(ReturnedSource),
  returnedQuantities: Schema.Array(ReturnedQuantity),
}) {}

/**
 * Archive an entity and sweep its unspent own sources to the customer in the
 * same command. An archived entity holds nothing and refuses every later write;
 * a call with no occupancy left to refuse is the only one that succeeds.
 *
 * The pool is not swept: it belongs to the customer and stays. A close after the
 * archive does not grant the entity a new plan — its plan sources ended here.
 *
 * ### Closing a scope and returning what it held
 * **Example:** Zero occupancy, then archive
 * ```typescript
 * const balances = yield* Paykit.Balances(account);
 * yield* balances.update({ entityId: "ent_support", featureId: "seats", usage: 0, idempotencyKey: "seats-0" });
 *
 * const entities = yield* Paykit.Entities(account);
 * const archived = yield* entities.archive({ entityId: "ent_support", idempotencyKey: "archive-support-1" });
 * ```
 *
 * @binding
 * @product Entities
 * @provides Paykit.Entities
 */
export class ArchiveEntity extends Domain.Command("ArchiveEntity", {
  target: AccountId,
  input: {
    entityId: EntityId,
  },
  events: [EntityArchivedEvent],
  rejects: [EntityUnknown, EntityArchived, EntityHasOccupancy, Forbidden, Unauthenticated],
  middleware: [Session],
}) {}
