import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import { Actor, type ActorValue, mayActOn } from "./Actor.ts";
import { Forbidden } from "./Forbidden.rejection.ts";
import { Admin, Session } from "./Guards.ts";
import { Unauthenticated } from "./Unauthenticated.rejection.ts";

/**
 * The part of a request a guard resolves the caller from: the headers, and the
 * decoded payload whose `target` scopes an account to itself.
 */
export interface GuardRequest {
  /** The request headers, as the Api received them. */
  readonly headers: Headers.Input;
  /** The decoded request body. A command and a read carry a `target`. */
  readonly payload: unknown;
}

/**
 * Resolve the caller a request carries, from whatever the deployment uses as a
 * session: a cookie, a bearer token, an identity provider SDK.
 *
 * Return `null` for an anonymous request. A **failure** is a broken identity
 * store, not an anonymous caller, and becomes a defect: answering
 * `Unauthenticated` would sign a valid caller out because a database was slow.
 *
 * ### Resolving a caller from a session
 * **Example:** A Better Auth session in a Worker
 * ```typescript
 * import * as Effect from "effect/Effect";
 *
 * const resolve: Paykit.ActorResolver = ({ headers }) =>
 *   auth.getSession(headers).pipe(
 *     Effect.map((session) =>
 *       session === null ? null : Paykit.actorAccount(session.user.id),
 *     ),
 *   );
 *
 * const guards = Paykit.GuardsFrom(resolve);
 * ```
 *
 * @primitive
 */
export type ActorResolver<E = never, R = never> = (
  request: GuardRequest,
) => Effect.Effect<ActorValue | null, E, R>;

/** What a guard names as the place it looked for a caller. */
export interface FromResolverOptions {
  /**
   * The source an `Unauthenticated` names: a cookie, a bearer token, the
   * deployment's session service. Defaults to `"session"`.
   */
  readonly source?: string;
}

/** The target a payload acts on, when it carries one. */
const targetOf = (payload: unknown): string | null => {
  const target = (payload as { readonly target?: unknown } | null)?.target;
  return typeof target === "string" ? target : null;
};

/**
 * The tenant guard over a resolver. Every command and read a signed-in account
 * may reach declares it: it provides the resolved `Actor`, refuses an
 * anonymous request, and pins an `account` actor to its own account while an
 * `admin` or the `system` may target any.
 *
 * This is the provider-neutral half of `SessionFromHeaders`: the billing model
 * never learns which identity provider answered. Better Auth, yielded/auth,
 * Clerk or a deployment's own session service all reduce to one resolver.
 *
 * ### Guarding the tenant surface with Better Auth
 * **Example:** One resolver, one guard
 * ```typescript
 * const session = (headers: Headers.Input) =>
 *   auth.getSession(headers).pipe(
 *     Effect.map((found) => (found === null ? null : Paykit.actorAccount(found.user.id))),
 *   );
 *
 * const Tenant = Paykit.SessionFrom(session);
 * ```
 *
 * @primitive
 */
export const SessionFrom = <E, R>(
  resolve: ActorResolver<E, R>,
  options: FromResolverOptions = {},
): Layer.Layer<Session, never, R> =>
  Layer.effect(
    Session,
    Effect.gen(function* () {
      const context: Context.Context<R> = yield* Effect.context<R>();
      const source = options.source ?? "session";
      return (effect, request) =>
        Effect.gen(function* () {
          const actor = yield* resolve(request).pipe(Effect.provideContext(context), Effect.orDie);
          if (actor === null) return yield* new Unauthenticated({ source });
          const target = targetOf(request.payload);
          if (target !== null && !mayActOn(actor, target)) {
            return yield* new Forbidden({ account: target, actor: actor.id, kind: actor.kind });
          }
          return yield* Effect.provideService(effect, Actor, actor);
        });
    }),
  );

/**
 * The operator guard over the same resolver. It requires an actor whose kind is
 * `admin`, so a tenant session cannot reach a command that grants credit,
 * expires a standing or replays a charge.
 *
 * An `admin` actor may target any account, so unlike {@link SessionFrom} the
 * payload's target is not checked: acting across accounts is the point.
 *
 * ### Reaching the operator surface
 * **Example:** An admin email becomes an operator actor
 * ```typescript
 * const admins = new Set(["ops@example.com"]);
 * const resolve: Paykit.ActorResolver = ({ headers }) =>
 *   auth.getSession(headers).pipe(
 *     Effect.map((session) =>
 *       session === null
 *         ? null
 *         : admins.has(session.user.email)
 *           ? Paykit.actorAdmin(session.user.id)
 *           : Paykit.actorAccount(session.user.id),
 *     ),
 *   );
 *
 * const Operator = Paykit.AdminFrom(resolve);
 * ```
 *
 * @primitive
 */
export const AdminFrom = <E, R>(
  resolve: ActorResolver<E, R>,
  options: FromResolverOptions = {},
): Layer.Layer<Admin, never, R> =>
  Layer.effect(
    Admin,
    Effect.gen(function* () {
      const context: Context.Context<R> = yield* Effect.context<R>();
      const source = options.source ?? "session";
      return (effect, request) =>
        Effect.gen(function* () {
          const actor = yield* resolve(request).pipe(Effect.provideContext(context), Effect.orDie);
          if (actor === null) return yield* new Unauthenticated({ source });
          if (actor.kind !== "admin") {
            return yield* new Forbidden({ account: actor.id, actor: actor.id, kind: actor.kind });
          }
          return yield* Effect.provideService(effect, Actor, actor);
        });
    }),
  );

/**
 * Both guards over one resolver, for a Worker that serves the tenant and the
 * operator surfaces from the same session.
 *
 * ### Serving both surfaces from one session
 * **Example:** One Worker, two clearances
 * ```typescript
 * const Guards = Paykit.GuardsFrom(resolve);
 *
 * if (path.startsWith("/api")) return yield* tenant.fetch;
 * if (path.startsWith("/admin")) return yield* admin.fetch;
 * ```
 *
 * @primitive
 */
export const GuardsFrom = <E, R>(
  resolve: ActorResolver<E, R>,
  options: FromResolverOptions = {},
): Layer.Layer<Session | Admin, never, R> =>
  Layer.mergeAll(SessionFrom(resolve, options), AdminFrom(resolve, options));
