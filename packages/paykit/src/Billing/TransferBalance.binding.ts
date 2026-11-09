import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { Balance } from "../Balance.ts";
import { ScopeRef } from "../Customer.ts";
import { EntityArchived } from "../Subscription/EntityArchived.rejection.ts";
import { EntityUnknown } from "../Subscription/EntityUnknown.rejection.ts";
import { NotSubscribed } from "../Subscription/NotSubscribed.rejection.ts";
import {
  TransferExceedsBalance,
  TransferOfCreditSystem,
  TransferOfPooledSource,
} from "../Subscription/TransferBalance.command.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/** Whether two scope references name the same scope. */
const sameScope = (left: ScopeRef, right: ScopeRef): boolean =>
  left.kind === "customer"
    ? right.kind === "customer"
    : right.kind === "entity" && left.entityId === right.entityId;

/**
 * Move balance units between two scopes of one customer. `from` and `to` are
 * scopes, never bare ids: a customer scope is spelled `{ kind: "customer" }`,
 * and an entity scope names its id (ADR 0040 §1).
 */
export const TransferBalanceRequest = Schema.Struct({
  /** The scope the units leave. */
  from: ScopeRef,
  /** The scope the units arrive in. */
  to: ScopeRef,
  /** The feature whose own sources move. */
  featureId: Schema.NonEmptyString,
  /** How many units to move. A transfer never borrows from the pool or a sibling. */
  amount: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  /** The retry key, which is also the command id. */
  idempotencyKey: Schema.NonEmptyString,
}).check(
  Schema.makeFilter((request) =>
    sameScope(request.from, request.to) ? "from and to must name different scopes" : undefined,
  ),
);

export type TransferBalanceRequest = typeof TransferBalanceRequest.Type;

/** The source and target scopes after the move, both read from the committed view. */
export const TransferBalanceResult = Schema.Struct({
  amount: Schema.Int,
  /** What the source scope has left, own sources only. */
  from: Balance,
  /** What the target scope now holds, own sources only. */
  to: Balance,
});

export type TransferBalanceResult = typeof TransferBalanceResult.Type;

/**
 * The two endpoints resolved to different customers. It is a binding refusal,
 * not a model one: `ScopeRef` carries no customer id, and one aggregate only
 * knows its own scopes, so a foreign id is indistinguishable from an unknown
 * one inside `decide` (ADR 0040 §1–2, brief Open question 2).
 */
export class TransferCrossCustomer extends Schema.TaggedError<TransferCrossCustomer>()(
  "TransferCrossCustomer",
  {
    customerId: Schema.String,
    from: ScopeRef,
    to: ScopeRef,
  },
) {}

const refusals = [
  TransferCrossCustomer,
  EntityUnknown,
  EntityArchived,
  TransferOfPooledSource,
  TransferOfCreditSystem,
  TransferExceedsBalance,
  NotSubscribed,
  Unauthenticated,
  Forbidden,
] as const;

/** Every refusal a transfer can answer. */
export type TransferBalanceRefusal = InstanceType<(typeof refusals)[number]>;

/** Whether a failure is this binding refusing the request. */
export const isTransferBalanceRefusal = oneOf<TransferBalanceRefusal>(refusals);

/** A layer's own failure, as this binding's declared union. */
export const toTransferBalanceError = toBindingError(
  "Paykit.TransferBalance",
  isTransferBalanceRefusal,
);

/** Everything a transfer can answer. */
export type TransferBalanceError = BindingError<TransferBalanceRefusal>;

/** The verb of a bound `TransferBalance`. */
export type TransferBalanceVerb = (
  request: TransferBalanceRequest,
) => Effect.Effect<TransferBalanceResult, TransferBalanceError>;

/**
 * Move balance units between the customer's own scope and one of its entities,
 * or between two entities. One command, one event, one transaction: a crash
 * cannot debit the source without crediting the target (ADR 0040 §5).
 *
 * It moves a scope's own sources only. The pool belongs to the customer and is
 * topped up by an attach, a credit system is one pool per customer, and
 * occupancy is not a balance — each is a refusal with its own evidence. Plan
 * units stay plan and lifetime units keep their deadline; a transfer can
 * shorten a deadline, never extend one.
 *
 * ### Moving an allowance between two teams
 * **Example:** One transfer, both after-values
 * ```typescript
 * const transfer = yield* Paykit.TransferBalance(account);
 * const moved = yield* transfer({
 *   from: { kind: "entity", entityId: Paykit.EntityId.make("ent_a") },
 *   to: { kind: "entity", entityId: Paykit.EntityId.make("ent_b") },
 *   featureId: "messages",
 *   amount: 250,
 *   idempotencyKey: "transfer-1",
 * });
 * moved.from.remaining; // the source scope after the move
 * moved.to.remaining;   // the target scope after the move
 * ```
 *
 * @binding
 * @product Entities
 * @provides Paykit.TransferBalance
 */
export interface TransferBalance extends Binding.Service<
  TransferBalance,
  "Paykit.TransferBalance",
  (account: string) => Effect.Effect<TransferBalanceVerb>
> {}

export const TransferBalance = Binding.Service<TransferBalance>("Paykit.TransferBalance");
