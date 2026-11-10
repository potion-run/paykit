import { describe, expect, it } from "@alchemy.run/test";
import {
  BillingAdminApi,
  BillingApi,
  Entitlements,
  Paykit,
  type Plan,
  Subscription,
} from "@potion.run/paykit";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { BillingTestLive } from "../src/Billing.layer.ts";
import { ai, billingCatalog, free, messages, pro, scale, seats, sso } from "../src/catalog.ts";
import { Tenant } from "../src/Tenant.ts";
import { subscribeInput } from "./support.ts";

/** The aggregate key and the Api target are the same branded id. */
const account = Subscription.ref("acct_example");

/** The dev guards read these; a real deployment replaces them with a session. */
const asAccount = { headers: { "x-paykit-actor": account.id } };
const asAdmin = { headers: { "x-paykit-actor": "ops_1", "x-paykit-kind": "admin" } };

/**
 * Run a test against the example's world. The effect may require exactly what
 * the world provides and nothing else, so the result needs no cast to be
 * runnable: a test that reaches for a service the world does not serve is a
 * compile error, not a runtime one.
 */
const run = <A, E, R>(effect: Effect.Effect<A, E, Layer.Success<typeof BillingTestLive> | R>) =>
  effect.pipe(Effect.provide(BillingTestLive));

/**
 * Activate a plan through the tenant Api's own `Subscribe` command, as a
 * settled checkout would. `tenant.subscribe` is the purchase path: a priced
 * plan answers the provider's invoice or checkout, and activation waits for the
 * webhook (`routes.test.ts` proves that loop). A test about what the model does
 * once the account is subscribed seeds the standing here, so it does not stand
 * in for a payment.
 */
const activate = (plan: Plan) =>
  Effect.gen(function* () {
    const tenant = yield* BillingApi.clientInProcess;
    const receipt = yield* tenant.Subscribe(account.id, yield* subscribeInput(plan), asAccount);
    const entitlements = yield* Entitlements;

    yield* entitlements.query(account, { atLeast: receipt });
  });

/**
 * Wait until the cross-account projection lists the account. `BillingRead`
 * consumes the view, so its row can trail the view a command's binding already
 * awaited.
 */
const listed = (id: string) =>
  Effect.gen(function* () {
    const list = yield* Paykit.List();

    return yield* list({ take: 10 }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 millis"),
        times: 200,
        until: (page) => page.rows.some((row) => row.account === id),
      }),
    );
  });

describe("the example billing app", () => {
  it.live("sells a free tier and answers check from local state", () =>
    Effect.gen(function* () {
      const tenant = yield* Tenant(account.id);
      const purchased = yield* tenant.subscribe({ plan: free });
      expect(purchased).toEqual({ activated: true });

      const answer = yield* tenant.check({ feature: messages, requiredBalance: 1 });
      expect(answer.allowed).toBe(true);
      expect(answer.balance.remaining).toBe(100);
      expect(answer.standing).toBe("good");
    }).pipe(run),
  );

  it.live("records usage in the same transaction that checks the allowance", () =>
    Effect.gen(function* () {
      const tenant = yield* Tenant(account.id);
      yield* tenant.subscribe({ plan: free });

      yield* tenant.track({ feature: messages, value: 60, idempotencyKey: "req-1" });
      // The same key records once.
      yield* tenant.track({ feature: messages, value: 60, idempotencyKey: "req-1" });

      expect((yield* tenant.check({ feature: messages })).balance.remaining).toBe(40);

      // A blocking allowance refuses before anything is written.
      const refused = yield* Effect.exit(
        tenant.track({ feature: messages, value: 41, idempotencyKey: "ex10" }),
      );

      expect(refused._tag).toBe("Failure");
      expect(String(refused)).toContain("AllowanceExceeded");
    }).pipe(run),
  );

  it.live("holds allowance for work in flight, then bills what it settles", () =>
    Effect.gen(function* () {
      const tenant = yield* Tenant(account.id);
      yield* tenant.subscribe({ plan: free });

      const first = yield* tenant.hold({
        feature: messages,
        amount: 30,
        dedupeKey: "turn-1",
      });

      // The held units are out of `remaining`, and none of them is billed yet.
      expect((yield* tenant.check({ feature: messages })).balance.remaining).toBe(70);

      // One call: 20 ran, so 20 is billed and the other 10 returns.
      const settled = yield* tenant.settleHold({
        dedupeKey: "ex9",
        holdId: first.holdId,
        amount: 20,
      });

      expect(settled.billed).toBe(20);
      expect(settled.released).toBe(10);
      expect(settled.balance.remaining).toBe(80);
      expect((yield* tenant.check({ feature: messages })).balance.remaining).toBe(80);

      // A hold nothing ran against comes back whole.
      const second = yield* tenant.hold({ dedupeKey: "ex8", feature: messages, amount: 10 });
      const released = yield* tenant.releaseHold({ dedupeKey: "ex7", holdId: second.holdId });

      expect(released.released).toBe(10);
      expect(released.balance.remaining).toBe(80);
      expect((yield* tenant.check({ feature: messages })).balance.remaining).toBe(80);
    }).pipe(run),
  );

  it.live("an unlimited allowance never runs out, so check reports no count", () =>
    Effect.gen(function* () {
      yield* activate(scale);
      const tenant = yield* Tenant(account.id);
      yield* tenant.track({ idempotencyKey: "ex6", feature: messages, value: 1_000_000 });

      const answer = yield* tenant.check({ feature: messages, requiredBalance: 1_000_000 });
      expect(answer.allowed).toBe(true);
      // Unlimited is the absence of a count, not a large one.
      expect(answer.balance.remaining).toBeNull();
      // The period still exists, so it still says when it ends.
      expect(answer.balance.nextResetAt).not.toBeNull();
      expect(answer.standing).toBe("good");
    }).pipe(run),
  );

  it.live("a granted flag is allowed but has nothing to track", () =>
    Effect.gen(function* () {
      yield* activate(scale);
      const tenant = yield* Tenant(account.id);

      const answer = yield* tenant.check({ feature: sso });
      expect(answer.allowed).toBe(true);
      // On/off: there is no count, and nothing ever resets.
      expect(answer.balance.remaining).toBeNull();
      expect(answer.balance.nextResetAt).toBeNull();

      // `tenant.track({ feature: sso, ... })` does not compile: `track` accepts
      // a `MeteredFeature`, and a flag is not one. The model's
      // `FeatureNotMetered` refusal is the runtime backstop behind the type.
    }).pipe(run),
  );

  it.live("sets a purchased seat count apart from the seats in use", () =>
    Effect.gen(function* () {
      yield* activate(pro);
      const tenant = yield* Tenant(account.id);

      // `pro` includes five seats; downsize the purchase to four, then report
      // two in use. The purchase and the occupancy are two different facts.
      const bought = yield* tenant.setQuantity({
        feature: seats,
        quantity: 4,
        dedupeKey: "seats-bought",
      });

      expect(bought.quantity).toBe(4);

      const occupied = yield* tenant.setUsage({
        feature: seats,
        usage: 2,
        idempotencyKey: "seats-used",
      });

      expect(occupied.usage).toBe(2);
      expect(occupied.remaining).toBe(2);

      // The same two facts through the read a page uses.
      expect((yield* tenant.check({ feature: seats })).balance.remaining).toBe(2);
    }).pipe(run),
  );

  it.live("rolls what a period did not spend into the next one", () =>
    Effect.gen(function* () {
      const tenant = yield* Tenant(account.id);
      const entitlements = yield* Entitlements;

      // A trial whose period ends almost immediately, so the rollover policy
      // closes it on its own and opens the next one. The deadline has to be
      // ahead of now — a trial cannot begin after it ends — so the wait below
      // is the policy's tick, not a fixed sleep.
      const ended = DateTime.makeUnsafe(Date.now() + 250);

      yield* tenant.startTrial({
        plan: pro,
        trialEndsAt: ended,
        dedupeKey: "ex-trial",
      });

      yield* tenant.track({ idempotencyKey: "ex4", feature: messages, value: 520 });

      // The rollover is the model's, not the test's: wait for the closed period
      // to be replaced before reading the answer.
      yield* entitlements.query(account).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 millis"),
          times: 500,
          until: (queried) =>
            Option.match(queried, {
              onNone: () => false,
              onSome: (state) =>
                DateTime.toEpochMillis(state.periodEnd) > DateTime.toEpochMillis(ended),
            }),
        }),
      );

      const answer = yield* tenant.check({ feature: messages, requiredBalance: 1 });
      // 1,480 unspent rolled over, so 3,480 is available — more than the 2,000
      // the tier includes. Whether the 520 was recorded before or after the
      // close, the answer is the same.
      expect(answer.balance.remaining).toBe(3_480);
      expect(answer.allowed).toBe(true);
    }).pipe(run),
  );

  it.live("prices a request in credits, by dimension, from one shared pool", () =>
    Effect.gen(function* () {
      yield* activate(scale);
      const tenant = yield* Tenant(account.id);

      // 100 large-model units at 10 credits each: 1,000 credits of the pool.
      yield* tenant.track({
        idempotencyKey: "ex3",
        feature: ai,
        value: 100,
        dimension: "gpt-large",
      });

      const answer = yield* tenant.check({
        feature: ai,
        requiredBalance: 1,
        dimension: "gpt-large",
      });

      expect(answer.allowed).toBe(true);
      // 50,000 granted, 1,000 spent: `remaining` is the pool, not a counter.
      expect(answer.balance.remaining).toBe(49_000);

      // 5,000 large-model units cost 50,000, which the pool cannot cover.
      const tooMuch = yield* tenant.check({
        feature: ai,
        requiredBalance: 5_000,
        dimension: "gpt-large",
      });

      expect(tooMuch.allowed).toBe(false);
      // The same 5,000 units at the default rate cost 5,000, which it can.
      expect((yield* tenant.check({ feature: ai, requiredBalance: 5_000 })).allowed).toBe(true);
    }).pipe(run),
  );

  it.live("bills up to the cap, then refuses while the standing stays good", () =>
    Effect.gen(function* () {
      yield* activate(pro);
      const tenant = yield* Tenant(account.id);

      // The whole allowance: 2,000 included plus the 10,000 the cap allows.
      yield* tenant.track({ idempotencyKey: "ex2", feature: messages, value: 12_000 });

      const atCeiling = yield* tenant.check({ feature: messages, requiredBalance: 1 });
      expect(atCeiling.allowed).toBe(false);
      // Out of what it bought, not in trouble.
      expect(atCeiling.standing).toBe("good");
      expect(atCeiling.balance.remaining).toBe(-10_000);

      const refused = yield* Effect.exit(
        tenant.track({ idempotencyKey: "ex1", feature: messages, value: 1 }),
      );

      expect(refused._tag).toBe("Failure");
      expect(String(refused)).toContain("SpendCapExceeded");
    }).pipe(run),
  );

  it.live("shows the charge before applying it", () =>
    Effect.gen(function* () {
      yield* activate(pro);
      const tenant = yield* Tenant(account.id);

      const result = yield* tenant.preview({ kind: "changeTier", plan: scale });

      expect(result._tag).toBe("accepted");

      if (result._tag !== "accepted") return;
      expect(result.proration?.due).toBe(8000);
      expect(result.events.map((event) => event._tag)).toEqual(["PlanChanged"]);
    }).pipe(run),
  );

  it.live("an operator grants credit, a tenant cannot", () =>
    Effect.gen(function* () {
      const tenant = yield* Tenant(account.id);
      const admin = yield* BillingAdminApi.clientInProcess;
      yield* tenant.subscribe({ plan: free });

      const granted = yield* admin.GrantCredits(account.id, { amount: 250 }, asAdmin);
      expect(granted.reply).toEqual({ balance: 250 });

      const refused = yield* Effect.exit(
        admin.GrantCredits(account.id, { amount: 250 }, asAccount),
      );

      expect(refused._tag).toBe("Failure");
      expect(String(refused)).toContain("Forbidden");
    }).pipe(run),
  );

  it.live("verify finds a checkout that never attached a vendor reference", () =>
    Effect.gen(function* () {
      yield* activate(pro);
      const verify = yield* Paykit.Verify();
      const mismatches = yield* verify({ account: account.id });

      expect(mismatches.map((mismatch) => mismatch._tag)).toEqual(["MissingProviderRef"]);
    }).pipe(run),
  );

  it.live("pages the accounts a dashboard shows", () =>
    Effect.gen(function* () {
      const tenant = yield* Tenant(account.id);
      yield* tenant.subscribe({ plan: free });
      yield* tenant.check({ feature: messages });

      const page = yield* listed(account.id);
      expect(page.rows.map((row) => row.account)).toContain(account.id);
      expect(page.rows[0]?.tier).toBe("free");
      expect(page.next).toBeNull();
    }).pipe(run),
  );

  it("the catalog the example ships is the one the deploy validates", () => {
    expect(billingCatalog.tiers.map((tier) => tier.id)).toEqual(["free", "pro", "scale"]);
    expect(billingCatalog.features.map((feature) => feature.id)).toEqual([
      "messages",
      "seats",
      "sso",
      "ai",
    ]);
  });
});
