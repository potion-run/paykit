import { describe, expect, it } from "@alchemy.run/test";
import { Actor, Admin, Session } from "@potion.run/paykit";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  actorFromCookie,
  AdminFromCookie,
  SessionFromCookie,
  sessionCookies,
} from "../src/Session.ts";

type Guard = (
  effect: Effect.Effect<unknown, never, Actor>,
  options: { readonly headers: Record<string, string>; readonly payload: unknown },
) => Effect.Effect<unknown, unknown, never>;

const session = Effect.runSync(
  Effect.scoped(
    Effect.map(Layer.build(SessionFromCookie), (context) => Context.get(context, Session)),
  ),
) as unknown as Guard;

const admin = Effect.runSync(
  Effect.scoped(Effect.map(Layer.build(AdminFromCookie), (context) => Context.get(context, Admin))),
) as unknown as Guard;

/** Run one guarded effect and report the actor it saw, or the failure tag. */
const guarded = (
  guard: Guard,
  headers: Record<string, string>,
  payload: unknown = { target: "acct_1" },
): { readonly actor: unknown } | { readonly error: string } =>
  Effect.runSync(
    Effect.gen(function* () {
      // `Actor` is the effect a guarded command runs with: it reads the actor
      // the middleware provided.
      const outcome = yield* Effect.exit(guard(Actor, { headers, payload }));
      if (Exit.isSuccess(outcome)) return { actor: outcome.value };
      const failure = Option.getOrNull(Cause.findErrorOption(outcome.cause)) as {
        readonly _tag: string;
      } | null;
      return { error: failure?._tag ?? "Defect" };
    }),
  );

describe("the cookie session", () => {
  it("names the actor in the cookie, and defaults to an account", () => {
    expect(actorFromCookie({ cookie: "pk_actor=ops_1; pk_kind=admin" })).toEqual({
      kind: "admin",
      id: "ops_1",
    });
    expect(actorFromCookie({ cookie: "pk_actor=acct_1" })).toEqual({
      kind: "account",
      id: "acct_1",
    });
    expect(actorFromCookie({ cookie: "pk_kind=admin" })).toBeNull();
    expect(actorFromCookie({ cookie: "pk_actor=acct_1; pk_kind=root" })).toBeNull();
    expect(actorFromCookie({})).toBeNull();
  });

  it("provides the cookie's actor, and refuses a request without one", () => {
    expect(guarded(session, { cookie: "pk_actor=acct_1" })).toEqual({
      actor: { kind: "account", id: "acct_1" },
    });
    // An account still may not target another account.
    expect(guarded(session, { cookie: "pk_actor=acct_1" }, { target: "acct_2" })).toEqual({
      error: "Forbidden",
    });
    expect(guarded(session, {})).toEqual({ error: "Unauthenticated" });
  });

  it("lets only an admin cookie reach the admin surface", () => {
    expect(guarded(admin, { cookie: "pk_actor=ops_1; pk_kind=admin" })).toEqual({
      actor: { kind: "admin", id: "ops_1" },
    });
    expect(guarded(admin, { cookie: "pk_actor=acct_1; pk_kind=account" })).toEqual({
      error: "Forbidden",
    });
    expect(guarded(admin, {})).toEqual({ error: "Unauthenticated" });
  });

  it("writes one HttpOnly, same-site Set-Cookie per cookie", () => {
    const local = sessionCookies({ kind: "admin", id: "ops_1" }, { secure: false });
    expect(local.map(([name, value]) => [name, value])).toEqual([
      ["pk_actor", "ops_1"],
      ["pk_kind", "admin"],
    ]);
    for (const [, , options] of local) {
      expect(options).toMatchObject({ httpOnly: true, path: "/", sameSite: "lax" });
      expect(options?.secure).toBeUndefined();
    }

    const secure = sessionCookies({ kind: "admin", id: "ops_1" }, { secure: true });
    expect(secure.every(([, , options]) => options?.secure === true)).toBe(true);
  });
});
