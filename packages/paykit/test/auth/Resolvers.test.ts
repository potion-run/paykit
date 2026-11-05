import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Actor, type ActorValue } from "../../src/Auth/Actor.ts";
import {
  AdminFrom,
  type ActorResolver,
  GuardsFrom,
  SessionFrom,
} from "../../src/Auth/FromResolver.ts";
import { Admin, Session } from "../../src/Auth/Guards.ts";

type Guard = (
  effect: Effect.Effect<unknown, never, Actor>,
  options: { readonly headers: Record<string, string>; readonly payload: unknown },
) => Effect.Effect<unknown, unknown, never>;

/** Read one middleware function out of a guard layer, as the Api would. */
const sessionGuard = (layer: Layer.Layer<Session, never, never>): Guard =>
  Effect.runSync(
    Effect.scoped(Effect.map(Layer.build(layer), (context) => Context.get(context, Session))),
  ) as unknown as Guard;

const adminGuard = (layer: Layer.Layer<Admin, never, never>): Guard =>
  Effect.runSync(
    Effect.scoped(Effect.map(Layer.build(layer), (context) => Context.get(context, Admin))),
  ) as unknown as Guard;

/** Both guards out of one layer, built once. */
const bothGuards = (layer: Layer.Layer<Session | Admin, never, never>) => {
  const context = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return {
    session: Context.get(context, Session) as unknown as Guard,
    admin: Context.get(context, Admin) as unknown as Guard,
  };
};

/** Run one guarded effect and report the actor it saw, or the failure tag. */
const guarded = (
  guard: Guard,
  headers: Record<string, string> = {},
  payload: unknown = { target: "acct_1" },
): { readonly actor: unknown } | { readonly error: string } =>
  Effect.runSync(
    Effect.gen(function* () {
      const outcome = yield* Effect.exit(guard(Actor, { headers, payload }));
      if (Exit.isSuccess(outcome)) return { actor: outcome.value };
      const failure = Option.getOrNull(Cause.findErrorOption(outcome.cause)) as {
        readonly _tag: string;
      } | null;
      return { error: failure?._tag ?? "Defect" };
    }),
  );

const account: ActorValue = { kind: "account", id: "acct_1" };
const operator: ActorValue = { kind: "admin", id: "ops_1" };

/** A resolver that always answers the same actor: a session already looked up. */
const answers =
  (actor: ActorValue | null): ActorResolver =>
  () =>
    Effect.succeed(actor);

describe("a guard over any session", () => {
  it("provides the actor the resolver answers, and refuses an anonymous request", () => {
    expect(guarded(sessionGuard(SessionFrom(answers(account))))).toEqual({ actor: account });
    expect(guarded(sessionGuard(SessionFrom(answers(null))))).toEqual({
      error: "Unauthenticated",
    });
  });

  it("pins an account to its own id, and lets an operator act on any", () => {
    expect(guarded(sessionGuard(SessionFrom(answers(account))), {}, { target: "acct_2" })).toEqual({
      error: "Forbidden",
    });
    expect(guarded(sessionGuard(SessionFrom(answers(operator))), {}, { target: "acct_2" })).toEqual(
      { actor: operator },
    );
    // A payload with no target — a stream or a health check — is not scoped.
    expect(guarded(sessionGuard(SessionFrom(answers(account))), {}, {})).toEqual({
      actor: account,
    });
  });

  it("puts the operator guard on the kind, not on the target", () => {
    expect(guarded(adminGuard(AdminFrom(answers(operator))), {}, {})).toEqual({
      actor: operator,
    });
    expect(guarded(adminGuard(AdminFrom(answers(account))), {}, {})).toEqual({
      error: "Forbidden",
    });
    expect(guarded(adminGuard(AdminFrom(answers(null))), {}, {})).toEqual({
      error: "Unauthenticated",
    });
  });

  it("builds both guards from one resolver", () => {
    const guards = bothGuards(GuardsFrom(answers(operator)));
    expect(guarded(guards.session, {}, { target: "acct_2" })).toEqual({ actor: operator });
    expect(guarded(guards.admin, {}, {})).toEqual({ actor: operator });
  });
});

/** A service a resolver may need: the deployment's own session store. */
class Sessions extends Context.Service<
  Sessions,
  { readonly actorOf: (token: string | null) => ActorValue | null }
>()("test/Sessions") {}

describe("a resolver with a dependency", () => {
  it("captures the service when the layer is built", () => {
    const resolve: ActorResolver<never, Sessions> = ({ headers }) =>
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const token = Headers.get(Headers.fromInput(headers), "authorization");
        return sessions.actorOf(Option.getOrNull(token));
      });
    const layer = SessionFrom(resolve).pipe(
      Layer.provide(
        Layer.succeed(Sessions, {
          actorOf: (token) => (token === "Bearer ops" ? operator : null),
        }),
      ),
    );
    expect(guarded(sessionGuard(layer), { authorization: "Bearer ops" }, {})).toEqual({
      actor: operator,
    });
    expect(guarded(sessionGuard(layer), {}, {})).toEqual({ error: "Unauthenticated" });
  });

  it("turns a broken session store into a defect, not an anonymous caller", () => {
    class SessionsDown extends Data.TaggedError("SessionsDown")<{}> {}
    const resolve: ActorResolver<SessionsDown> = () => Effect.fail(new SessionsDown());
    // The resolver's typed failure is not part of the guard's error channel, so
    // a caller cannot mistake it for a refusal.
    expect(guarded(sessionGuard(SessionFrom(resolve)), {}, {})).toEqual({ error: "Defect" });
  });
});
