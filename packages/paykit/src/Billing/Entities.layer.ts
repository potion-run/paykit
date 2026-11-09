import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CustomerId, EntityId, type Entity } from "../Customer.ts";
import type { BillingStateView, EntityView } from "../Subscription/BillingState.view.ts";
import { EntityUnknown } from "../Subscription/EntityUnknown.rejection.ts";
import { BindingFailed, mapBindingFailure, type ReceiptRef } from "./Bindings.ts";
import {
  Entities,
  type EntitiesError,
  type EntityArchiveRequest,
  type EntityCreateRequest,
  type EntityUpdateRequest,
  toEntitiesError,
} from "./Entities.binding.ts";

/**
 * The read an `Entities` verb answers from: one account's billing view, the
 * same row `Customers.get()` renders. It is a service so the in-process world
 * and the Api world compose one binding instead of mapping the view twice.
 *
 * @primitive
 */
export class EntitiesRead extends Context.Service<
  EntitiesRead,
  {
    readonly view: (
      account: string,
      atLeast?: ReceiptRef,
    ) => Effect.Effect<BillingStateView | null, EntitiesError>;
  }
>()("paykit/EntitiesRead") {}

/**
 * The three writes an `Entities` verb makes. A layer implements only the send
 * and answers the receipt; `EntitiesLive` reads the view it waited for, so both
 * transports report the state a caller's next read sees.
 *
 * @primitive
 */
export class EntityWrites extends Context.Service<
  EntityWrites,
  {
    readonly create: (
      account: string,
      request: EntityCreateRequest,
    ) => Effect.Effect<ReceiptRef, EntitiesError>;
    readonly update: (
      account: string,
      request: EntityUpdateRequest,
    ) => Effect.Effect<ReceiptRef, EntitiesError>;
    readonly archive: (
      account: string,
      request: EntityArchiveRequest,
    ) => Effect.Effect<ReceiptRef, EntitiesError>;
  }
>()("paykit/EntityWrites") {}

/** Map the view's entity row to the public record. Plans and balances stay on its `Balance`. */
const entityOf = (account: string, entity: EntityView): Entity => ({
  id: EntityId.make(entity.id),
  parentId: CustomerId.make(account),
  ...(entity.name === undefined ? {} : { name: entity.name }),
  status: entity.status,
  createdAt: entity.createdAt,
  ...(entity.archivedAt === undefined ? {} : { archivedAt: entity.archivedAt }),
});

/** The entity a write left, or a binding failure when the view has not caught up. */
const written = (
  account: string,
  view: BillingStateView | null,
  entityId: EntityId,
): Effect.Effect<Entity, EntitiesError> => {
  const found = view?.entities.find((entity) => entity.id === entityId);

  return found === undefined
    ? Effect.fail(
        new BindingFailed({
          binding: "Paykit.Entities",
          message: `the write committed but the view has no entity ${entityId}`,
        }),
      )
    : Effect.succeed(entityOf(account, found));
};

/**
 * A customer's child scopes, composed from the three entity commands and the
 * billing view they project into. It adds no second model: an entity is a
 * partition of the customer's aggregate, so every write is one command on that
 * aggregate and every read is the view it already folded (ADR 0040 §2).
 *
 * @layer
 * @product Entities
 * @provides Paykit.Entities
 */
export const EntitiesLive = Layer.effect(
  Entities,
  Effect.gen(function* () {
    const read = yield* EntitiesRead;
    const writes = yield* EntityWrites;

    const viewOf = (account: string, atLeast?: ReceiptRef) =>
      mapBindingFailure(toEntitiesError)(read.view(account, atLeast));

    return Effect.fn("Paykit.Entities")(function* (account) {
      return {
        create: Effect.fn("Paykit.Entities.create")(function* (request) {
          const receipt = yield* writes.create(account, request);
          const view = yield* viewOf(account, receipt);

          return yield* written(account, view, request.entityId);
        }),
        get: Effect.fn("Paykit.Entities.get")(function* (entityId) {
          const view = yield* viewOf(account);
          const found = view?.entities.find((entity) => entity.id === entityId);

          if (found === undefined) return yield* new EntityUnknown({ account, entityId });

          return entityOf(account, found);
        }),
        list: Effect.fn("Paykit.Entities.list")(function* () {
          const view = yield* viewOf(account);

          return (view?.entities ?? []).map((entity) => entityOf(account, entity));
        }),
        update: Effect.fn("Paykit.Entities.update")(function* (request) {
          const receipt = yield* writes.update(account, request);
          const view = yield* viewOf(account, receipt);

          return yield* written(account, view, request.entityId);
        }),
        archive: Effect.fn("Paykit.Entities.archive")(function* (request) {
          const receipt = yield* writes.archive(account, request);
          const view = yield* viewOf(account, receipt);

          return yield* written(account, view, request.entityId);
        }),
      };
    });
  }),
);
