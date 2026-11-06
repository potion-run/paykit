import { expect, it } from "@alchemy.run/test";
import { Paykit } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import { BillingTestLive, Catalog } from "../src/Billing.ts";

const account = "acct_tanstack_example";

it("ships the catalog the deploy validates", () => {
  expect(Catalog.tiers.map((tier) => tier.id)).toEqual(["free", "pro"]);
  expect(Catalog.features.map((feature) => feature.id)).toEqual(["messages"]);
});

it.live("the operation the Worker's bootstrap calls starts the free tier", () =>
  Effect.gen(function* () {
    const subscribeOf = yield* Paykit.Subscribe;
    const subscribe = yield* subscribeOf(account);
    expect(yield* subscribe({ tier: "free" })).toEqual({ activated: true });

    // The standing is there for the Api client the browser's atom runtime
    // builds; the Atom package's own test covers that path end to end.
    const checkOf = yield* Paykit.Check(account);
    const answer = yield* checkOf({ feature: "messages", amount: 1 });
    expect(answer.allowed).toBe(true);
    expect(answer.remaining).toBe(100);
  }).pipe(Effect.provide(BillingTestLive)),
);
