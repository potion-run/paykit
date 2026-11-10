import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ActorKind, type ActorValue } from "./Actor.ts";
import { AdminFrom, type ActorResolver, GuardsFrom, SessionFrom } from "./FromResolver.ts";

/**
 * The header a caller names itself in, and the header naming its kind. Read
 * only by the development guards: a production deployment replaces them with a
 * resolver over its own session, so the header never becomes an authentication
 * scheme by accident.
 */
export const ACTOR_HEADER = "x-paykit-actor";
export const KIND_HEADER = "x-paykit-kind";

/** The actor the development guards read from a request's headers. */
export const actorFromHeaders = (headers: Headers.Input): ActorValue | null => {
  const read = Headers.fromInput(headers);
  const id = Headers.get(read, ACTOR_HEADER);

  if (Option.isNone(id)) return null;
  const kind = Headers.get(read, KIND_HEADER);
  const decoded = Schema.decodeUnknownOption(ActorKind)(Option.getOrElse(kind, () => "account"));

  if (Option.isNone(decoded)) return null;

  return { kind: decoded.value, id: id.value };
};

/**
 * The account id a request's development header names, for
 * `Paykit.handler`'s `accountOf`.
 *
 * The same header the insecure guards read, reduced to the one field a
 * purchase needs. A deployment with its own session resolves its actor once,
 * in its auth file, and hands the handler that resolver's `actor.id`.
 *
 * ### A checkout's account
 * **Example:** The handler's account resolver over the development header
 * ```typescript
 * const handler = yield* Paykit.handler({
 *   provider,
 *   accountOf: (request) => Paykit.accountFromHeaders(request.headers),
 * });
 * ```
 *
 * @primitive
 */
export const accountFromHeaders = (headers: Headers.Input): string | null =>
  actorFromHeaders(headers)?.id ?? null;

/** The development resolver: the actor a request's headers name. */
const fromHeaders: ActorResolver = ({ headers }) => Effect.sync(() => actorFromHeaders(headers));

/**
 * Insecure: it trusts the `x-paykit-actor` header, so any caller can name
 * itself. It exists so `alchemy dev`, the console and the tests can exercise
 * the guarded path without an identity provider.
 *
 * Never expose this to the internet. A production deployment uses
 * {@link SessionFrom} over its own session; the name is the warning.
 *
 * @layer
 */
export const InsecureSessionFromHeaders = SessionFrom(fromHeaders, { source: "insecure headers" });

/**
 * Insecure: it trusts the `x-paykit-kind` header, so any caller can declare
 * itself an operator. It exists for the development console and the tests.
 *
 * Never expose this to the internet. A production deployment uses
 * {@link AdminFrom} over its own session.
 *
 * @layer
 */
export const InsecureAdminFromHeaders = AdminFrom(fromHeaders, { source: "insecure headers" });

/**
 * Both insecure development guards, for a Worker that serves the tenant and the
 * admin surface from one process.
 *
 * Never expose this to the internet.
 *
 * @layer
 */
export const InsecureDevGuards = GuardsFrom(fromHeaders, { source: "insecure headers" });
