import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { EntityId, type Entity } from "../Customer.ts";
import { EntityArchived } from "../Subscription/EntityArchived.rejection.ts";
import { EntityExists } from "../Subscription/EntityExists.rejection.ts";
import { EntityHasOccupancy } from "../Subscription/EntityHasOccupancy.rejection.ts";
import { EntityUnknown } from "../Subscription/EntityUnknown.rejection.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/** A name an entity may carry: present, non-empty and short enough to render. */
const EntityName = Schema.optionalKey(
  Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(120))),
);

/** The id a caller names. An empty id is not a scope, so it is a schema failure. */
const EntityKey = EntityId.pipe(Schema.check(Schema.isMinLength(1)));

/** The retry key for a rename or an archive. Omitted, each call is its own id. */
const IdempotencyKey = Schema.optionalKey(
  Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200))),
);

/** Create a child scope under the bound customer. */
export const EntityCreateRequest = Schema.Struct({
  /** The scope's id. It is never reused after the entity is archived (ADR 0040 §7). */
  entityId: EntityKey,
  /** The label a console shows. */
  name: EntityName,
});

export type EntityCreateRequest = typeof EntityCreateRequest.Type;

/** Rename a child scope, or clear its name. */
export const EntityUpdateRequest = Schema.Struct({
  entityId: EntityKey,
  /** Omitted clears the name; the id, plan set and balances do not move. */
  name: EntityName,
  /** The retry key. Omitted, a retry still records nothing when the name is equal. */
  idempotencyKey: IdempotencyKey,
});

export type EntityUpdateRequest = typeof EntityUpdateRequest.Type;

/** Archive a child scope and sweep its unspent own sources to the customer. */
export const EntityArchiveRequest = Schema.Struct({
  entityId: EntityKey,
  /** The retry key. An archive is terminal, so a retry with the same key replays. */
  idempotencyKey: IdempotencyKey,
});

export type EntityArchiveRequest = typeof EntityArchiveRequest.Type;

const refusals = [
  EntityExists,
  EntityUnknown,
  EntityArchived,
  EntityHasOccupancy,
  Unauthenticated,
  Forbidden,
] as const;

/** Every refusal an entity write can answer. */
export type EntitiesRefusal = InstanceType<(typeof refusals)[number]>;

/** Whether a failure is this binding refusing the request. */
export const isEntitiesRefusal = oneOf<EntitiesRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toEntitiesError = toBindingError("Paykit.Entities", isEntitiesRefusal);

/** Everything an entity read or write can answer. */
export type EntitiesError = BindingError<EntitiesRefusal>;

/** The five operations a customer's child scopes have. */
export interface EntitiesVerb {
  /** Create a scope. The command id is the entity id, so a retry replays. */
  create(request: EntityCreateRequest): Effect.Effect<Entity, EntitiesError>;
  /** One scope, or `EntityUnknown`. */
  get(entityId: EntityId): Effect.Effect<Entity, EntitiesError>;
  /** Every scope this customer ever attached, archived ones included, in id order. */
  list(): Effect.Effect<ReadonlyArray<Entity>, EntitiesError>;
  /** Rename a scope. An equal name records nothing. */
  update(request: EntityUpdateRequest): Effect.Effect<Entity, EntitiesError>;
  /** Archive a scope and return what it held to the customer. */
  archive(request: EntityArchiveRequest): Effect.Effect<Entity, EntitiesError>;
}

/**
 * A customer's child scopes: a team, a project, a workspace. An entity is a
 * scope under the customer's one aggregate, not a second customer — it has its
 * own plan set and balance sources, and a read for it is a filtered read of the
 * customer's view (ADR 0040 §1–3).
 *
 * `create` is idempotent by `entityId`; `update` records nothing when the name
 * is unchanged; `archive` is terminal and returns the scope's unspent own
 * sources to the customer in the same command. Nothing a bill references is
 * deleted, so `list` keeps archived scopes too.
 *
 * ### One team, its own plan, then its closure
 * **Example:** Create, plan, archive
 * ```typescript
 * const entities = yield* Paykit.Entities(account);
 * const support = yield* entities.create({
 *   entityId: Paykit.EntityId.make("ent_support"),
 *   name: "Support",
 * });
 *
 * const attach = yield* Paykit.Attach(account);
 * yield* attach({ entityId: support.id, planId: "team", idempotencyKey: "attach-team-1" });
 *
 * const archived = yield* entities.archive({
 *   entityId: support.id,
 *   idempotencyKey: "archive-support-1",
 * });
 * ```
 *
 * @binding
 * @product Entities
 * @provides Paykit.Entities
 */
export interface Entities extends Binding.Service<
  Entities,
  "Paykit.Entities",
  (account: string) => Effect.Effect<EntitiesVerb>
> {}

export const Entities = Binding.Service<Entities>("Paykit.Entities");
