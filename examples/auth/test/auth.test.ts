import { BetterAuth, Memory } from "@alchemy.run/better-auth";
import { describe, expect, it } from "@alchemy.run/test";
import { BillingAdminApi, BillingApi, Subscription } from "@potion.run/paykit";
import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerRequestModule from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { type AuthInstance, actorOf, Auth, authGuards } from "../src/Auth.ts";
import { BillingTestLive, tierCommand } from "../src/Billing.ts";
import { serve } from "../src/Worker.ts";

const secret = "test-secret-test-secret-test-secret";
const adminEmail = "ops@example.com";

/** The account id is the Better Auth user id, branded once at the boundary. */
const accountOf = (id: string) => Subscription.ref(id).id;

/** A Better Auth instance on the in-memory adapter: no D1, no network. */
const makeAuth = BetterAuth({
  baseURL: "http://localhost",
  emailAndPassword: { enabled: true },
  secret,
}).pipe(Effect.provide(Memory()), Effect.provide(RuntimeContext.phantom));

/** Sign up over Better Auth's own HTTP route and keep the session cookie. */
const signUp = (auth: AuthInstance, email: string) =>
  Effect.gen(function* () {
    const request = new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ name: "Example User", email, password: "example-password-123" }),
    });
    const response = yield* auth.fetch.pipe(
      Effect.provideService(HttpServerRequest, HttpServerRequestModule.fromWeb(request)),
      Effect.provide(RuntimeContext.phantom),
      Effect.scoped,
      Effect.orDie,
    );
    const web = HttpServerResponse.toWeb(response);
    expect(web.status).toBe(200);
    const body = (yield* Effect.promise(() => web.json())) as {
      readonly user: { readonly id: string; readonly email: string };
    };
    const cookie = web.headers
      .getSetCookie()
      .map((entry) => entry.split(";", 1)[0]!)
      .join("; ");
    expect(cookie.length).toBeGreaterThan(0);
    return { id: body.user.id, email: body.user.email, cookie };
  });

/** The world one test serves: the billing model, the guards and the auth service. */
const world = (auth: AuthInstance) =>
  Layer.mergeAll(
    BillingTestLive,
    Layer.succeed(Auth, auth),
    authGuards(auth, new Set([adminEmail])),
  );

/** Call the Worker's own fetch, as a browser or a provider would. */
const call = (
  server: {
    readonly fetch: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      unknown,
      HttpServerRequest | RuntimeContext | Scope.Scope
    >;
  },
  request: Request,
) =>
  server.fetch.pipe(
    Effect.provideService(HttpServerRequest, HttpServerRequestModule.fromWeb(request)),
    Effect.provide(RuntimeContext.phantom),
    Effect.scoped,
    Effect.orDie,
    Effect.map(HttpServerResponse.toWeb),
  );

describe("the auth-gated billing app", () => {
  it("maps a Better Auth session to the paykit actor", () => {
    expect(actorOf(null, new Set())).toBeNull();
    expect(actorOf({ user: { id: "user_1", email: "user@example.com" } }, new Set())).toEqual({
      kind: "account",
      id: "user_1",
    });
    expect(actorOf({ user: { id: "user_1", email: adminEmail } }, new Set([adminEmail]))).toEqual({
      kind: "admin",
      id: "user_1",
    });
  });

  it.live("serves the tenant Api only to the session that owns the account", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth;
      const user = yield* signUp(auth, "user@example.com");
      const account = accountOf(user.id);

      yield* Effect.gen(function* () {
        const tenant = yield* BillingApi.clientInProcess;
        const asUser = { headers: { cookie: user.cookie } };

        // The account id is the Better Auth user id. It is not a parameter the
        // caller may choose: a session for this user can only act for itself.
        yield* tenant.Subscribe(account, tierCommand("free"), asUser);
        const receipt = yield* tenant.TrackUsage(
          account,
          { feature: "messages", amount: 5, dedupeKey: "first" },
          asUser,
        );
        const view = yield* tenant.Entitlements.get(account, { atLeast: receipt, ...asUser });
        expect(view?.features.messages?.remaining).toBe(95);

        // A request with no session never reaches the model.
        const anonymous = yield* Effect.exit(
          tenant.TrackUsage(account, { feature: "messages", amount: 1, dedupeKey: "anon" }),
        );
        expect(anonymous._tag).toBe("Failure");
        expect(String(anonymous)).toContain("Unauthenticated");

        // A signed-in account may not act on another account.
        const other = yield* Effect.exit(
          tenant.TrackUsage(
            accountOf("someone-else"),
            { feature: "messages", amount: 1, dedupeKey: "other" },
            asUser,
          ),
        );
        expect(other._tag).toBe("Failure");
        expect(String(other)).toContain("Forbidden");
      }).pipe(Effect.provide(world(auth)));
    }),
  );

  it.live("keeps the operator surface on the admin list, not on any session", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth;
      const user = yield* signUp(auth, "user@example.com");
      const operator = yield* signUp(auth, adminEmail);
      const account = accountOf(user.id);

      yield* Effect.gen(function* () {
        const tenant = yield* BillingApi.clientInProcess;
        const admin = yield* BillingAdminApi.clientInProcess;

        yield* tenant.Subscribe(account, tierCommand("free"), {
          headers: { cookie: user.cookie },
        });

        const refused = yield* Effect.exit(
          admin.GrantCredits(account, { amount: 500 }, { headers: { cookie: user.cookie } }),
        );
        expect(refused._tag).toBe("Failure");
        expect(String(refused)).toContain("Forbidden");

        const granted = yield* admin.GrantCredits(
          account,
          { amount: 500 },
          { headers: { cookie: operator.cookie } },
        );
        expect(granted.reply).toEqual({ balance: 500 });
      }).pipe(Effect.provide(world(auth)));
    }),
  );

  it.live("derives the checkout account from the session, never from the query", () =>
    Effect.gen(function* () {
      const auth = yield* makeAuth;
      const user = yield* signUp(auth, "user@example.com");

      yield* Effect.gen(function* () {
        const server = yield* serve;
        const anonymous = yield* call(server, new Request("http://localhost/checkout?tier=pro"));
        expect(anonymous.status).toBe(401);

        const signedIn = yield* call(
          server,
          new Request("http://localhost/checkout?tier=pro&account=someone-else", {
            headers: { cookie: user.cookie },
          }),
        );
        expect(signedIn.status).toBe(200);
        const body = (yield* Effect.promise(() => signedIn.json())) as {
          readonly invoiceId?: string;
        };
        // `Manual` sells through an invoice. The account on it is the session's
        // user id; the query's `account` is ignored by construction.
        expect(typeof body.invoiceId).toBe("string");
      }).pipe(Effect.provide(world(auth)));
    }),
  );
});
