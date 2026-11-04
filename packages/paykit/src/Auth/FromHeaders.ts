import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Actor, ActorKind, type ActorValue, mayActOn } from "./Actor.ts";
import { Forbidden } from "./Forbidden.rejection.ts";
import { Admin, Session } from "./Guards.ts";
import { Unauthenticated } from "./Unauthenticated.rejection.ts";

/**
 * The header a caller names itself in, and the header naming its kind. Read
 * only by the development guards: a production deployment replaces them with a
 * Layer over its own session, so the header never becomes an authentication
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

const targetOf = (payload: unknown): string | null => {
  const target = (payload as { readonly target?: unknown } | null)?.target;
  return typeof target === "string" ? target : null;
};

const unauthenticated = new Unauthenticated({ source: "headers" });

/**
 * The development `Session` guard: the caller is the `x-paykit-actor` header,
 * of the kind named by `x-paykit-kind` (default `account`). An `account`
 * caller may only target itself; an `admin` or `system` caller may target any
 * account.
 *
 * Never expose this to the internet. It exists so `alchemy dev`, the console
 * and the tests can exercise the guarded path without an identity provider.
 *
 * @layer
 */
export const SessionFromHeaders = Layer.succeed(Session, (effect, { headers, payload }) => {
  const actor = actorFromHeaders(headers);
  if (actor === null) return Effect.fail(unauthenticated);
  const target = targetOf(payload);
  if (target !== null && !mayActOn(actor, target)) {
    return Effect.fail(new Forbidden({ account: target, actor: actor.id, kind: actor.kind }));
  }
  return Effect.provideService(effect, Actor, actor);
});

/**
 * The development `Admin` guard: the caller must present the `admin` kind in
 * `x-paykit-kind`. Unlike `SessionFromHeaders` it does not need a target,
 * because an operator acting on any account is the point.
 *
 * Never expose this to the internet.
 *
 * @layer
 */
export const AdminFromHeaders = Layer.succeed(Admin, (effect, { headers }) => {
  const actor = actorFromHeaders(headers);
  if (actor === null) return Effect.fail(unauthenticated);
  if (actor.kind !== "admin") {
    return Effect.fail(new Forbidden({ account: actor.id, actor: actor.id, kind: actor.kind }));
  }
  return Effect.provideService(effect, Actor, actor);
});

/**
 * Both development guards, for a Worker that serves the tenant and the admin
 * surface from one process.
 *
 * @layer
 */
export const DevGuards = Layer.mergeAll(SessionFromHeaders, AdminFromHeaders);
