import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Who is calling. An `account` may only act on itself, an `admin` may act on
 * any account, and `system` is a sender inside the deployment (a webhook
 * translator, a policy, a migration) that already authenticated upstream.
 */
export const ActorKind = Schema.Literals(["account", "admin", "system"]);
export type ActorKind = typeof ActorKind.Type;

/** The caller a request carries into the domain. */
export const ActorSchema = Schema.Struct({
  kind: ActorKind,
  /** The account for `account`, the operator for `admin`, the component for `system`. */
  id: Schema.String,
});
export type ActorValue = typeof ActorSchema.Type;

/**
 * The caller of a request, provided by the `Session` or `Admin` middleware and
 * carried with the command. Read it in a `View`'s `validate` and in your own
 * middleware; `decide` stays pure and does not read it.
 *
 * ### Declaring a request context
 * **Example:** Reading the caller in a read's `validate`
 * ```typescript
 * import * as Effect from "effect/Effect";
 *
 * validate: Effect.fn(function* ({ key }) {
 *   const actor = yield* Actor;
 *   if (actor.kind === "account" && actor.id !== key.id) return yield* new Forbidden({ account: key.id });
 * }),
 * ```
 *
 * @primitive
 */
export class Actor extends Domain.RequestContext<Actor>()("paykit/Actor", ActorSchema) {}

/** A sender inside the deployment: a webhook translator, a policy, a script. */
export const system = (id = "paykit"): ActorValue => ({ kind: "system", id });

/** An operator of the deployment. */
export const admin = (id: string): ActorValue => ({ kind: "admin", id });

/** A signed-in account. */
export const account = (id: string): ActorValue => ({ kind: "account", id });

/** Whether the actor may act on any account, rather than only on itself. */
export const actsForAnyAccount = (actor: ActorValue): boolean =>
  actor.kind === "admin" || actor.kind === "system";

/**
 * Whether this actor may act on this account. The one rule every surface
 * shares: an account may act on itself, an admin or the system may act on
 * anything. Pure, so a middleware and a `validate` cannot disagree.
 */
export const mayActOn = (actor: ActorValue, accountId: string): boolean =>
  actsForAnyAccount(actor) || actor.id === accountId;

/**
 * Provide the system actor to a send that runs inside the deployment: a
 * webhook translator, a policy, a projection replay, a migration. The
 * deployment already authenticated the work, so the send does not ask a
 * request for a session it will never have.
 *
 * ### Sending as the system
 * **Example:** A webhook that activates an account
 * ```typescript
 * yield* asSystem(subscription.send(ref, new Subscribe({ ... }), { commandId: event.id }));
 * ```
 */
export const asSystem = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Actor, system());
