import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Forbidden } from "../Auth/Forbidden.rejection.ts";
import { Session } from "../Auth/Guards.ts";
import { Unauthenticated } from "../Auth/Unauthenticated.rejection.ts";
import { ScopeRef } from "../Customer.ts";
import { EntityArchived } from "./EntityArchived.rejection.ts";
import { EntityUnknown } from "./EntityUnknown.rejection.ts";
import { NotSubscribed } from "./NotSubscribed.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/**
 * A transfer names the customer's own scope for a feature whose grant is pooled.
 * The pool is a plan item on the parent, attached and closed: it is one source
 * every attached entity draws on, so moving units "into" or "out of" it would be
 * a second pool. Topping the pool up is an attach (ADR 0040 §6).
 */
export class TransferOfPooledSource extends Domain.Rejection("TransferOfPooledSource", {
  from: ScopeRef,
  to: ScopeRef,
  feature: Schema.String,
}) {}

/**
 * A transfer names a credit-priced feature. Credits are one pool per customer
 * (ADR 0002) and are not entity-scoped: an entity reaches them through a pooled
 * plan item, and moving them between scopes would be a second pool
 * (ADR 0040 §6).
 */
export class TransferOfCreditSystem extends Domain.Rejection("TransferOfCreditSystem", {
  feature: Schema.String,
}) {}

/**
 * A transfer asks for more than the source scope owns. The ceiling is the
 * source's own sources — its plan, rollover and grants — never the shared pool
 * and never a sibling's balance: a transfer does not borrow (ADR 0040 §6).
 */
export class TransferExceedsBalance extends Domain.Rejection("TransferExceedsBalance", {
  from: ScopeRef,
  feature: Schema.String,
  amount: Schema.Int,
  /** What the source scope owned when the transfer was decided. */
  available: Schema.Int,
}) {}

/**
 * One scope's own units moved to another scope of the same customer, as one
 * event. `plan` and `grant` are the source's classes and sum to `amount`: plan
 * units stay plan and lifetime units stay lifetime, so a transfer never turns a
 * lifetime grant into an expiring one (ADR 0040 §5).
 */
export class BalanceTransferred extends Domain.Event("BalanceTransferred", {
  /** The command id, so a target grant the move created has a stable id. */
  transferId: Schema.String,
  from: ScopeRef,
  to: ScopeRef,
  feature: Schema.String,
  amount: Schema.Int,
  /** The plan-and-rollover part of the move. */
  plan: Schema.Int,
  /** The lifetime part of the move; `plan + grant === amount`. */
  grant: Schema.Int,
  /** The reset interval the source ran on. */
  interval: Schema.String,
  /** The earlier deadline the units now carry, when the source carried one. */
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
  /**
   * The grant units the move took, keyed by the source's grant id. It is the
   * allocation `decide` made, so replay deducts the same grants.
   */
  grantsUsed: Schema.optionalKey(Schema.Record(Schema.String, Schema.Int)),
  /** The source scope's own remaining after the move. */
  fromAfter: Schema.Int,
  /** The target scope's own remaining after the move. */
  toAfter: Schema.Int,
}) {}

/**
 * Move units between two scopes of one customer: the customer's own scope and
 * one of its entities, or two entities. One command, one transaction, one event,
 * so a crash cannot debit the source without crediting the target.
 *
 * It moves balance units, never occupancy (ADR 0036), never a credit system
 * (ADR 0002) and never the pooled source. It is decided from the two scopes'
 * sources alone: no clock, provider or catalog read, so `decide` stays pure.
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
export class TransferBalance extends Domain.Command("TransferBalance", {
  target: AccountId,
  input: {
    from: ScopeRef,
    to: ScopeRef,
    feature: Schema.String,
    amount: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  },
  events: [BalanceTransferred],
  rejects: [
    TransferOfPooledSource,
    TransferOfCreditSystem,
    TransferExceedsBalance,
    NotSubscribed,
    EntityUnknown,
    EntityArchived,
    Forbidden,
    Unauthenticated,
  ],
  middleware: [Session],
}) {}
