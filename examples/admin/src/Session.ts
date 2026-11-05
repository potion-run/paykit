import { Actor, ActorKind, type ActorValue, mayActOn } from "@potion.run/paykit/Auth/Actor";
import { Forbidden } from "@potion.run/paykit/Auth/Forbidden.rejection";
import { Admin, Session } from "@potion.run/paykit/Auth/Guards";
import { Unauthenticated } from "@potion.run/paykit/Auth/Unauthenticated.rejection";
import * as Effect from "effect/Effect";
import * as Cookies from "effect/http/Cookies";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The example's session. A browser cannot set headers on a WebSocket, so the
 * console's live reads cannot carry a header pair; a same-origin `HttpOnly`
 * cookie rides every `fetch`, RPC call and WebSocket handshake instead, which
 * is what lets the example use `Domain.protocolWebSocket`.
 *
 * This is still a development identity: `/session` mints it without an
 * identity provider. A real deployment resolves the actor from its own
 * session service and sets the cookie with `HttpOnly; Secure; SameSite=Lax`.
 */
export const ACTOR_COOKIE = "pk_actor";
export const KIND_COOKIE = "pk_kind";

const cookieValue = (cookie: string, name: string): string | null => {
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
};

/** The actor a request's cookie names, or `null` when it names none. */
export const actorFromCookie = (headers: Headers.Input): ActorValue | null => {
  const cookie = Headers.get(Headers.fromInput(headers), "cookie");
  if (Option.isNone(cookie)) return null;
  const id = cookieValue(cookie.value, ACTOR_COOKIE);
  if (id === null || id === "") return null;
  const kind = Schema.decodeUnknownOption(ActorKind)(
    cookieValue(cookie.value, KIND_COOKIE) ?? "account",
  );
  if (Option.isNone(kind)) return null;
  return { kind: kind.value, id };
};

/**
 * The cookies `/session` writes: one `Set-Cookie` per cookie, because a browser
 * stores only the first name=value pair in a combined header. `Secure` is only
 * added over HTTPS, so `alchemy dev` on `http://localhost` can still set them.
 */
export const sessionCookies = (
  actor: ActorValue,
  options: { secure: boolean },
): ReadonlyArray<readonly [string, string, Cookies.Cookie["options"]]> => {
  const cookieOptions: Cookies.Cookie["options"] = {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    ...(options.secure ? { secure: true } : {}),
  };
  return [
    [ACTOR_COOKIE, actor.id, cookieOptions],
    [KIND_COOKIE, actor.kind, cookieOptions],
  ];
};

/**
 * The actor the example mints for `/session`. A production host replaces this
 * with whatever its identity provider already authenticated.
 */
export const exampleActor: ActorValue = { kind: "admin", id: "ops_1" };

const targetOf = (payload: unknown): string | null => {
  const target = (payload as { readonly target?: unknown } | null)?.target;
  return typeof target === "string" ? target : null;
};

const unauthenticated = new Unauthenticated({ source: "session cookie" });

/**
 * The cookie `Session` guard: the caller is the cookie's actor, and an
 * `account` caller may still only target itself. It is the same rule as
 * `SessionFromHeaders`, read from the one place a browser can put a session.
 */
export const SessionFromCookie = Layer.succeed(Session, (effect, { headers, payload }) => {
  const actor = actorFromCookie(headers);
  if (actor === null) return Effect.fail(unauthenticated);
  const target = targetOf(payload);
  if (target !== null && !mayActOn(actor, target)) {
    return Effect.fail(new Forbidden({ account: target, actor: actor.id, kind: actor.kind }));
  }
  return Effect.provideService(effect, Actor, actor);
});

/** The cookie `Admin` guard: the cookie's actor must be an operator. */
export const AdminFromCookie = Layer.succeed(Admin, (effect, { headers }) => {
  const actor = actorFromCookie(headers);
  if (actor === null) return Effect.fail(unauthenticated);
  if (actor.kind !== "admin") {
    return Effect.fail(new Forbidden({ account: actor.id, actor: actor.id, kind: actor.kind }));
  }
  return Effect.provideService(effect, Actor, actor);
});

/** Both cookie guards, for the Worker that serves the admin surfaces. */
export const CookieGuards = Layer.mergeAll(SessionFromCookie, AdminFromCookie);
