import { expect, it } from "@alchemy.run/test";
import { BillingReadStore, type BillingReadRow } from "@potion.run/paykit";
import { AdminReads, AdminReadsLive } from "@potion.run/paykit/Admin";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BillingTestLive, Catalog } from "../src/Billing.ts";

const World = AdminReadsLive.pipe(Layer.provideMerge(BillingTestLive));

const at = DateTime.makeUnsafe("2030-01-01T00:00:00Z");

const row: BillingReadRow = {
  account: "acct_admin",
  tier: "free",
  status: "active",
  standing: "good",
  periodStart: at,
  periodEnd: at,
  cancelAtPeriodEnd: false,
  credits: 0,
  dunningAttempts: 0,
  features: {},
};

it.live("serves the catalog and an account page to the console", () =>
  Effect.gen(function* () {
    const store = yield* BillingReadStore;
    yield* store.upsert(row);
    const reads = yield* AdminReads;

    const catalog = yield* reads.catalog();
    expect(catalog.tiers.map((tier) => tier.id)).toEqual(["free", "pro", "scale"]);

    const page = yield* reads.list({ take: 10 });
    expect(page.rows.map((entry) => entry.account)).toEqual(["acct_admin"]);

    const preview = yield* reads.preview({
      account: "acct_admin",
      command: { kind: "cancel" },
    });
    expect(preview._tag).toBe("rejected");

    const mismatches = yield* reads.verify({ account: "acct_admin" });
    expect(mismatches).toEqual([]);
  }).pipe(Effect.provide(World)),
);

it("ships the catalog the deploy validates", () => {
  expect(Catalog.tiers.map((tier) => tier.id)).toEqual(["free", "pro", "scale"]);
  expect(Catalog.features.map((feature) => feature.id)).toEqual(["messages", "seats"]);
});
