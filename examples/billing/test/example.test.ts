import { describe, expect, it } from "@alchemy.run/test";
import {
  BillingAdminApi,
  BillingApi,
  Entitlements,
  Paykit,
  Subscription,
} from "@potion.run/paykit";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { BillingTestLive, Catalog } from "../src/Billing.ts";
import { tierCommand } from "./support.ts";

/** The aggregate key and the Api target are the same branded id. */
const account = Subscription.ref("acct_example");

/** The dev guards read these; a real deployment replaces them with a session. */
const asAccount = { headers: { "x-paykit-actor": account.id } };
const asAdmin = { headers: { "x-paykit-actor": "ops_1", "x-paykit-kind": "admin" } };

/** The tier a test sells; the catalog is validated at load, so this cannot refuse. */
const free = Effect.runSync(tierCommand("free"));
const pro = Effect.runSync(tierCommand("pro"));

/**
 * Run a test against the example's world. The effect may require exactly what
 * the world provides and nothing else, so the result needs no cast to be
 * runnable: a test that reaches for a service the world does not serve is a
 * compile error, not a runtime one.
 */
const run = <A, E, R>(effect: Effect.Effect<A, E, Layer.Success<typeof BillingTestLive> | R>) =>
  effect.pipe(Effect.provide(BillingTestLive));

/**
 * A command over the Api commits its events and returns; the read models catch
 * up behind it. Wait for the view before reading it, exactly as an HTTP route
 * would when it needs the answer in the same response.
 */
const caughtUp = (receipt: { readonly stream: string; readonly version: number }) =>
  Effect.gen(function* () {
    const entitlements = yield* Entitlements;
    yield* entitlements.query(account, { atLeast: receipt });
  });

/**
 * Wait until the cross-account projection lists the account. `BillingRead`
 * consumes the view, so its row can trail the view a `caughtUp` awaited.
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
      const tenant = yield* BillingApi.clientInProcess;
      const receipt = yield* tenant.Subscribe(account.id, free, asAccount);
      yield* caughtUp(receipt);

      const check = yield* Paykit.Check(account.id);
      const answer = yield* check({ featureId: "messages", requiredBalance: 1 });
      expect(answer.allowed).toBe(true);
      expect(answer.balance.remaining).toBe(100);
      expect(answer.standing).toBe("good");
      expect(receipt.stream).toContain("Subscription/");
    }).pipe(run),
  );

  it.live("records usage in the same transaction that checks the allowance", () =>
    Effect.gen(function* () {
      const tenant = yield* BillingApi.clientInProcess;
      const receipt = yield* tenant.Subscribe(account.id, free, asAccount);
      yield* caughtUp(receipt);

      const track = yield* Paykit.TrackUsage(account.id);
      yield* track({ featureId: "messages", value: 60, idempotencyKey: "req-1" });
      // The same key records once.
      yield* track({ featureId: "messages", value: 60, idempotencyKey: "req-1" });

      const check = yield* Paykit.Check(account.id);
      expect((yield* check({ featureId: "messages" })).balance.remaining).toBe(40);

      // A blocking allowance refuses before anything is written.
      const refused = yield* Effect.exit(
        track({ idempotencyKey: "ex10", featureId: "messages", value: 41 }),
      );

      expect(refused._tag).toBe("Failure");
      expect(String(refused)).toContain("AllowanceExceeded");
    }).pipe(run),
  );

  it.live("holds allowance for work in flight, then bills what it settles", () =>
    Effect.gen(function* () {
      const tenant = yield* BillingApi.clientInProcess;
      const receipt = yield* tenant.Subscribe(account.id, free, asAccount);
      yield* caughtUp(receipt);

      const hold = yield* Paykit.Hold(account.id);
      const settle = yield* Paykit.SettleHold(account.id);
      const release = yield* Paykit.ReleaseHold(account.id);
      const check = yield* Paykit.Check(account.id);

      const first = yield* hold({
        feature: "messages",
        amount: 30,
        dedupeKey: "turn-1",
      });

      // The held units are out of `remaining`, and none of them is billed yet.
      expect((yield* check({ featureId: "messages" })).balance.remaining).toBe(70);

      // One call: 20 ran, so 20 is billed and the other 10 returns.
      const settled = yield* settle({ dedupeKey: "ex9", holdId: first.holdId, amount: 20 });
      expect(settled.billed).toBe(20);
      expect(settled.released).toBe(10);
      expect(settled.balance.remaining).toBe(80);
      expect((yield* check({ featureId: "messages" })).balance.remaining).toBe(80);

      // A hold nothing ran against comes back whole.
      const second = yield* hold({ dedupeKey: "ex8", feature: "messages", amount: 10 });
      const released = yield* release({ dedupeKey: "ex7", holdId: second.holdId });
      expect(released.released).toBe(10);
      expect(released.balance.remaining).toBe(80);
      expect((yield* check({ featureId: "messages" })).balance.remaining).toBe(80);
    }).pipe(run),
  );

  it.live("an unlimited allowance never runs out, so check reports no count", () =>
    Effect.gen(function* () {
      const tenant = yield* BillingApi.clientInProcess;
      const scale = yield* tierCommand("scale");
      const receipt = yield* tenant.Subscribe(account.id, scale, asAccount);
      yield* caughtUp(receipt);

      const track = yield* Paykit.TrackUsage(account.id);
      yield* track({ idempotencyKey: "ex6", featureId: "messages", value: 1_000_000 });

      const check = yield* Paykit.Check(account.id);
      const answer = yield* check({ featureId: "messages", requiredBalance: 1_000_000 });
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
      const tenant = yield* BillingApi.clientInProcess;
      const scale = yield* tierCommand("scale");
      const receipt = yield* tenant.Subscribe(account.id, scale, asAccount);
      yield* caughtUp(receipt);

      const check = yield* Paykit.Check(account.id);
      const answer = yield* check({ featureId: "sso" });
      expect(answer.allowed).toBe(true);
      // On/off: there is no count, and nothing ever resets.
      expect(answer.balance.remaining).toBeNull();
      expect(answer.balance.nextResetAt).toBeNull();

      // SSO cannot be consumed, so recording it is refused by tag.
      const track = yield* Paykit.TrackUsage(account.id);

      const refused = yield* Effect.exit(
        track({ idempotencyKey: "ex5", featureId: "sso", value: 1 }),
      );

      expect(refused._tag).toBe("Failure");
      expect(String(refused)).toContain("FeatureNotMetered");
    }).pipe(run),
  );

  it.live("rolls what a period did not spend into the next one", () =>
    Effect.gen(function* () {
      const tenant = yield* BillingApi.clientInProcess;
      const entitlements = yield* Entitlements;

      // A trial whose period ends almost immediately, so the rollover policy
      // closes it on its own and opens the next one. The deadline has to be
      // ahead of now — a trial cannot begin after it ends — so the wait below
      // is the policy's tick, not a fixed sleep.
      const ended = DateTime.makeUnsafe(Date.now() + 250);
      yield* tenant.StartTrial(account.id, { ...pro, trialEndsAt: ended }, asAccount);

      const track = yield* Paykit.TrackUsage(account.id);
      yield* track({ idempotencyKey: "ex4", featureId: "messages", value: 520 });

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

      const check = yield* Paykit.Check(account.id);
      const answer = yield* check({ featureId: "messages", requiredBalance: 1 });
      // 1,480 unspent rolled over, so 3,480 is available — more than the 2,000
      // the tier includes. Whether the 520 was recorded before or after the
      // close, the answer is the same.
      expect(answer.balance.remaining).toBe(3_480);
      expect(answer.allowed).toBe(true);
    }).pipe(run),
  );

  it.live("prices a request in credits, by dimension, from one shared pool", () =>
    Effect.gen(function* () {
      const tenant = yield* BillingApi.clientInProcess;
      const scale = yield* tierCommand("scale");
      const receipt = yield* tenant.Subscribe(account.id, scale, asAccount);
      yield* caughtUp(receipt);

      const track = yield* Paykit.TrackUsage(account.id);
      // 100 large-model units at 10 credits each: 1,000 credits of the pool.
      yield* track({
        idempotencyKey: "ex3",
        featureId: "ai",
        value: 100,
        dimension: "gpt-large",
      });

      const check = yield* Paykit.Check(account.id);

      const answer = yield* check({
        featureId: "ai",
        requiredBalance: 1,
        dimension: "gpt-large",
      });

      expect(answer.allowed).toBe(true);
      // 50,000 granted, 1,000 spent: `remaining` is the pool, not a counter.
      expect(answer.balance.remaining).toBe(49_000);

      // 5,000 large-model units cost 50,000, which the pool cannot cover.
      const tooMuch = yield* check({
        featureId: "ai",
        requiredBalance: 5_000,
        dimension: "gpt-large",
      });

      expect(tooMuch.allowed).toBe(false);
      // The same 5,000 units at the default rate cost 5,000, which it can.
      expect((yield* check({ featureId: "ai", requiredBalance: 5_000 })).allowed).toBe(true);
    }).pipe(run),
  );

  it.live("bills up to the cap, then refuses while the standing stays good", () =>
    Effect.gen(function* () {
      const tenant = yield* BillingApi.clientInProcess;
      const receipt = yield* tenant.Subscribe(account.id, pro, asAccount);
      yield* caughtUp(receipt);

      const track = yield* Paykit.TrackUsage(account.id);
      // The whole allowance: 2,000 included plus the 10,000 the cap allows.
      yield* track({ idempotencyKey: "ex2", featureId: "messages", value: 12_000 });

      const check = yield* Paykit.Check(account.id);
      const atCeiling = yield* check({ featureId: "messages", requiredBalance: 1 });
      expect(atCeiling.allowed).toBe(false);
      // Out of what it bought, not in trouble.
      expect(atCeiling.standing).toBe("good");
      expect(atCeiling.balance.remaining).toBe(-10_000);

      const refused = yield* Effect.exit(
        track({ idempotencyKey: "ex1", featureId: "messages", value: 1 }),
      );

      expect(refused._tag).toBe("Failure");
      expect(String(refused)).toContain("SpendCapExceeded");
    }).pipe(run),
  );

  it.live("shows the charge before applying it", () =>
    Effect.gen(function* () {
      const tenant = yield* BillingApi.clientInProcess;
      const receipt = yield* tenant.Subscribe(account.id, pro, asAccount);
      yield* caughtUp(receipt);

      const preview = yield* Paykit.Preview(account.id);

      const result = yield* preview({
        command: { kind: "changeTier", tier: "scale" },
      });

      expect(result._tag).toBe("accepted");

      if (result._tag !== "accepted") return;
      expect(result.proration?.due).toBe(8000);
      expect(result.events.map((event) => event._tag)).toEqual(["PlanChanged"]);
    }).pipe(run),
  );

  it.live("an operator grants credit, a tenant cannot", () =>
    Effect.gen(function* () {
      const tenant = yield* BillingApi.clientInProcess;
      const admin = yield* BillingAdminApi.clientInProcess;
      const receipt = yield* tenant.Subscribe(account.id, free, asAccount);
      yield* caughtUp(receipt);

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
      const tenant = yield* BillingApi.clientInProcess;
      yield* tenant.Subscribe(account.id, pro, asAccount);
      const verify = yield* Paykit.Verify();
      const mismatches = yield* verify({ account: account.id });
      expect(mismatches.map((mismatch) => mismatch._tag)).toEqual(["MissingProviderRef"]);
    }).pipe(run),
  );

  it.live("pages the accounts a dashboard shows", () =>
    Effect.gen(function* () {
      const tenant = yield* BillingApi.clientInProcess;
      const receipt = yield* tenant.Subscribe(account.id, free, asAccount);
      yield* caughtUp(receipt);
      // Wait for the view, then for the projection that consumes it.
      const check = yield* Paykit.Check(account.id);
      yield* check({ featureId: "messages" });
      const page = yield* listed(account.id);
      expect(page.rows.map((row) => row.account)).toContain(account.id);
      expect(page.rows[0]?.tier).toBe("free");
      expect(page.next).toBeNull();
    }).pipe(run),
  );

  it("the catalog the example ships is the one the deploy validates", () => {
    expect(Catalog.tiers.map((tier) => tier.id)).toEqual(["free", "pro", "scale"]);
    expect(Catalog.features.map((feature) => feature.id)).toEqual([
      "messages",
      "seats",
      "sso",
      "ai",
    ]);
  });
});
