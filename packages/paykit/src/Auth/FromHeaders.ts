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

/** The development resolver: the actor a request's headers name. */
const fromHeaders: ActorResolver = ({ headers }) => Effect.sync(() => actorFromHeaders(headers));

/**
 * The development `Session` guard: the caller is the `x-paykit-actor` header,
 * of the kind named by `x-paykit-kind` (default `account`). An `account`
 * caller may only target itself; an `admin` or `system` caller may target any
 * account.
 *
 * It is {@link SessionFrom} over a header resolver, so a production deployment
 * swaps the resolver and keeps the guard.
 *
 * Never expose this to the internet. It exists so `alchemy dev`, the console
 * and the tests can exercise the guarded path without an identity provider.
 *
 * @layer
 */
export const SessionFromHeaders = SessionFrom(fromHeaders, { source: "headers" });

/**
 * The development `Admin` guard: the caller must present the `admin` kind in
 * `x-paykit-kind`. Unlike `SessionFromHeaders` it does not need a target,
 * because an operator acting on any account is the point.
 *
 * Never expose this to the internet.
 *
 * @layer
 */
export const AdminFromHeaders = AdminFrom(fromHeaders, { source: "headers" });

/**
 * Both development guards, for a Worker that serves the tenant and the admin
 * surface from one process.
 *
 * @layer
 */
export const DevGuards = GuardsFrom(fromHeaders, { source: "headers" });
