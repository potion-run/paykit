import { BetterAuth, type BetterAuthApiError } from "@alchemy.run/better-auth";
import {
  type Admin,
  type ActorResolver,
  type ActorValue,
  Paykit,
  type Session,
} from "@potion.run/paykit";
import { RuntimeContext } from "alchemy";
import type { HttpEffect } from "alchemy/Http";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/**
 * The Better Auth instance and the paykit guards over it.
 *
 * Better Auth owns sign-up, sign-in, the session cookie and the auth tables.
 * paykit owns the billing account and never learns which provider answered:
 * `authGuards` maps a Better Auth session to one `Actor` and hands it to
 * `Paykit.GuardsFrom`. Replacing Better Auth with yielded/auth, Clerk or an
 * own session service changes this file and nothing below it.
 */
export const makeAuth = Effect.gen(function* () {
  const baseURL = yield* Config.String("AUTH_BASE_URL").pipe(Config.option);

  return yield* BetterAuth({
    basePath: "/api/auth",
    emailAndPassword: { enabled: true },
    // Locally, Better Auth uses the incoming request's origin. A deployment
    // sets `AUTH_BASE_URL` so the OAuth callback and trusted origin are stable.
    ...(Option.isSome(baseURL) ? { baseURL: baseURL.value } : {}),
  });
});

export type AuthInstance = {
  /** Better Auth's own HTTP surface: sign-up, sign-in, sessions. */
  readonly fetch: HttpEffect<RuntimeContext>;
  /** The session for the ambient request, or for explicit headers. */
  readonly getSession: {
    (): Effect.Effect<AuthSession | null, BetterAuthApiError, RuntimeContext | HttpServerRequest>;
    (
      headers: globalThis.Headers,
    ): Effect.Effect<AuthSession | null, BetterAuthApiError, RuntimeContext>;
  };
};

/** The Better Auth instance, as a service the guards and the Worker resolve. */
export class Auth extends Context.Service<Auth, AuthInstance>()("example/Auth") {
  static readonly layer = Layer.effect(Auth, makeAuth);
}

/** A Better Auth session, narrowed to what the billing actor needs. */
export interface AuthSession {
  readonly user: SessionUser;
}

/** The user fields the example reads. */
export interface SessionUser {
  readonly id: string;
  readonly email: string;
}

/**
 * A Better Auth session as a paykit actor. The account is the user id: one user
 * is one billing account.
 *
 * A product where a team owns the subscription maps
 * `session.session.activeOrganizationId` instead. Nothing in paykit changes;
 * only this function does.
 */
export const actorOf = (
  session: AuthSession | null,
  admins: ReadonlySet<string>,
): ActorValue | null => {
  if (session === null) return null;
  const { id, email } = session.user;

  return admins.has(id) || admins.has(email) ? Paykit.actorAdmin(id) : Paykit.actorAccount(id);
};

/** The request's headers as the native `Headers` Better Auth reads. */
const webHeaders = (input: Headers.Input): globalThis.Headers => {
  const headers = new globalThis.Headers();

  for (const [name, value] of Object.entries(Headers.fromInput(input))) {
    headers.set(name, value);
  }

  return headers;
};

/**
 * The Better Auth resolver: the one identity mapping the guards and a
 * non-Api route share.
 *
 * `getSession` returning `null` is an anonymous request; a failing session store
 * is a defect, so a transient database error cannot sign a valid user out.
 */
export const authResolver =
  (auth: AuthInstance, admins: ReadonlySet<string>): ActorResolver<BetterAuthApiError> =>
  ({ headers }) =>
    auth.getSession(webHeaders(headers)).pipe(
      // The Worker (or the test) owns the request scope; this only satisfies
      // the type, exactly as Alchemy's own middleware does for HttpApi.
      Effect.provide(RuntimeContext.phantom),
      Effect.map((session) => actorOf(session, admins)),
    );

/**
 * The resolver as a service, so a route that is not an Api — the checkout —
 * resolves the same actor as the guards. Without it, `/checkout` would call
 * `auth.getSession()` again and grow a second identity mapping.
 */
export class SessionResolver extends Context.Service<
  SessionResolver,
  ActorResolver<BetterAuthApiError>
>()("example/SessionResolver") {}

/**
 * Both guards and the resolver, for one Better Auth instance. `admins` names
 * the user ids or emails allowed to reach the operator surface.
 */
export const authGuards = (
  auth: AuthInstance,
  admins: ReadonlySet<string>,
): Layer.Layer<Session | Admin | SessionResolver, never, never> => {
  const resolve = authResolver(auth, admins);

  return Layer.mergeAll(Paykit.GuardsFrom(resolve), Layer.succeed(SessionResolver, resolve));
};

const AdminIds = Config.String("PAYKIT_ADMIN_EMAILS").pipe(
  Config.withDefault(""),
  Config.map(
    (value) =>
      new Set(
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
  ),
);

/**
 * Both guards over the deployed Better Auth instance. `PAYKIT_ADMIN_EMAILS` is
 * a comma-separated list of user ids or emails; everyone else is a tenant.
 */
export const AuthGuards: Layer.Layer<Session | Admin | SessionResolver, Config.ConfigError, Auth> =
  Layer.unwrap(
    Effect.gen(function* () {
      const auth = yield* Auth;
      const admins = yield* AdminIds;

      return authGuards(auth, admins);
    }),
  );
