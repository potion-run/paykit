import { describe, expect, it } from "@alchemy.run/test";
import {
  BillingAdminApi,
  BillingApi,
  Entitlements,
  Paykit,
  Subscription,
} from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import { BillingTestLive, Catalog, tierCommand } from "../src/Billing.ts";

/** The aggregate key and the Api target are the same branded id. */
const account = Subscription.ref("acct_example");

/** The dev guards read these; a real deployment replaces them with a session. */
const asAccount = { headers: { "x-paykit-actor": account.id } };
const asAdmin = { headers: { "x-paykit-actor": "ops_1", "x-paykit-kind": "admin" } };

const free = tierCommand("free");
const pro = tierCommand("pro");

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(BillingTestLive)) as Effect.Effect<A, E, never>;

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

describe("the example billing app", () => {
  it.live("sells a free tier and answers check from local state", () =>
    Effect.gen(function* () {
      const tenant = yield* BillingApi.clientInProcess;
      const receipt = yield* tenant.Subscribe(account.id, free, asAccount);
      yield* caughtUp(receipt);

      const check = yield* Paykit.Check();
      const answer = yield* check({ account: account.id, feature: "messages", amount: 1 });
      expect(answer.allowed).toBe(true);
      expect(answer.remaining).toBe(100);
      expect(answer.standing).toBe("good");
      expect(receipt.stream).toContain("Subscription/");
    }).pipe(run),
  );

  it.live("records usage in the same transaction that checks the allowance", () =>
    Effect.gen(function* () {
      const tenant = yield* BillingApi.clientInProcess;
      const receipt = yield* tenant.Subscribe(account.id, free, asAccount);
      yield* caughtUp(receipt);

      const track = yield* Paykit.Track();
      yield* track({ account: account.id, feature: "messages", amount: 60, dedupeKey: "req-1" });
      // The same key records once.
      yield* track({ account: account.id, feature: "messages", amount: 60, dedupeKey: "req-1" });

      const check = yield* Paykit.Check();
      expect((yield* check({ account: account.id, feature: "messages" })).remaining).toBe(40);

      // A blocking allowance refuses before anything is written.
      const refused = yield* Effect.exit(
        track({ account: account.id, feature: "messages", amount: 41 }),
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

      const reserve = yield* Paykit.Reserve();
      const settle = yield* Paykit.Settle();
      const release = yield* Paykit.Release();
      const check = yield* Paykit.Check();

      yield* reserve({
        account: account.id,
        feature: "messages",
        amount: 30,
        dedupeKey: "turn-1",
      });
      // The held units are out of `remaining`, and none of them is billed yet.
      expect((yield* check({ account: account.id, feature: "messages" })).remaining).toBe(70);

      yield* settle({ account: account.id, feature: "messages", amount: 20 });
      yield* release({ account: account.id, feature: "messages", amount: 10 });
      // 20 billed and 10 returned: 100 - 20 is spendable again, and nothing held.
      expect((yield* check({ account: account.id, feature: "messages" })).remaining).toBe(80);
    }).pipe(run),
  );

  it.live("shows the charge before applying it", () =>
    Effect.gen(function* () {
      const tenant = yield* BillingApi.clientInProcess;
      const receipt = yield* tenant.Subscribe(account.id, pro, asAccount);
      yield* caughtUp(receipt);

      const preview = yield* Paykit.Preview();
      const result = yield* preview({
        account: account.id,
        command: { kind: "changeTier", tier: "scale" },
      });
      expect(result._tag).toBe("accepted");
      if (result._tag !== "accepted") return;
      expect(result.proration?.due).toBe(8000);
      expect(result.events.map((event) => event._tag)).toEqual(["TierChanged"]);
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
      // The projection consumes the view, so wait for it too.
      const check = yield* Paykit.Check();
      yield* check({ account: account.id, feature: "messages" });
      const list = yield* Paykit.List();
      const page = yield* list({ take: 10 });
      expect(page.rows.map((row) => row.account)).toContain(account.id);
      expect(page.rows[0]?.tier).toBe("free");
      expect(page.next).toBeNull();
    }).pipe(run),
  );

  it("the catalog the example ships is the one the deploy validates", () => {
    expect(Catalog.tiers.map((tier) => tier.id)).toEqual(["free", "pro", "scale"]);
    expect(Catalog.features.map((feature) => feature.id)).toEqual(["messages", "seats"]);
  });
});
