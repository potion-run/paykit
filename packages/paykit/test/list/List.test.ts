import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  BillingReadStore,
  DEFAULT_PAGE,
  MAX_PAGE,
  MemoryBillingReadStore,
  type BillingReadRow,
  queryRows,
} from "../../src/BillingReadStore.ts";
import { List } from "../../src/List.ts";
import { standingOf } from "../../src/Subscription/Subscription.state.ts";

const at = Effect.runSync(
  Effect.succeed(new Date("2030-01-01T00:00:00Z")).pipe(
    Effect.map((date) => date as unknown as never),
  ),
);

const row = (account: string, overrides: Partial<BillingReadRow> = {}): BillingReadRow =>
  ({
    account,
    tier: "pro",
    status: "active",
    standing: standingOf("active"),
    periodStart: at,
    periodEnd: at,
    cancelAtPeriodEnd: false,
    credits: 0,
    features: {},
    ...overrides,
  }) as BillingReadRow;

const accounts = ["acct_a", "acct_b", "acct_c", "acct_d", "acct_e"];

describe("cross-account list", () => {
  it("walks every account once, in a stable cursor order", () => {
    const rows = accounts.map((account) => row(account));
    const first = queryRows(rows, { take: 2 });
    expect(first.rows.map((entry) => entry.account)).toEqual(["acct_a", "acct_b"]);
    expect(first.next).toBe("acct_b");

    const second = queryRows(rows, { take: 2, after: first.next! });
    expect(second.rows.map((entry) => entry.account)).toEqual(["acct_c", "acct_d"]);

    const last = queryRows(rows, { take: 2, after: second.next! });
    expect(last.rows.map((entry) => entry.account)).toEqual(["acct_e"]);
    expect(last.next).toBeNull();
  });

  it("an account created between pages shifts no row", () => {
    const first = queryRows(
      accounts.map((account) => row(account)),
      { take: 2 },
    );
    // A new account sorts before the cursor, so it is not served twice.
    const grown = ["acct_0", ...accounts].map((account) => row(account));
    const second = queryRows(grown, { take: 2, after: first.next! });
    expect(second.rows.map((entry) => entry.account)).toEqual(["acct_c", "acct_d"]);
    // A new account after the cursor is served, and nothing is skipped.
    const appended = [...accounts, "acct_f"].map((account) => row(account));
    const tail = queryRows(appended, { take: 3, after: second.next! });
    expect(tail.rows.map((entry) => entry.account)).toEqual(["acct_e", "acct_f"]);
  });

  it("orders descending when asked", () => {
    const page = queryRows(
      accounts.map((account) => row(account)),
      { order: "desc", take: 2 },
    );
    expect(page.rows.map((entry) => entry.account)).toEqual(["acct_e", "acct_d"]);
    expect(page.next).toBe("acct_d");
  });

  it("filters by standing, tier and status before paging", () => {
    const rows = [
      row("acct_a"),
      row("acct_b", { standing: "grace", status: "grace" }),
      row("acct_c", { tier: "scale" }),
      row("acct_d", { standing: "grace", status: "grace", tier: "scale" }),
    ];
    expect(queryRows(rows, { standing: "grace" }).rows.map((entry) => entry.account)).toEqual([
      "acct_b",
      "acct_d",
    ]);
    expect(queryRows(rows, { tier: "scale" }).rows.map((entry) => entry.account)).toEqual([
      "acct_c",
      "acct_d",
    ]);
    expect(
      queryRows(rows, { standing: "grace", tier: "scale" }).rows.map((entry) => entry.account),
    ).toEqual(["acct_d"]);
  });

  it("caps the page size", () => {
    const many = Array.from({ length: MAX_PAGE + 20 }, (_, index) =>
      row(`acct_${String(index).padStart(4, "0")}`),
    );
    expect(queryRows(many, { take: 10_000 }).rows.length).toBe(MAX_PAGE);
    expect(queryRows(many).rows.length).toBe(DEFAULT_PAGE);
  });

  it("is empty, not failing, on an account count below one page", () => {
    const page = queryRows([]);
    expect(page.rows).toEqual([]);
    expect(page.next).toBeNull();
  });
});

describe("the List binding", () => {
  it.live("pages the projection through the store", () =>
    Effect.gen(function* () {
      const store = yield* BillingReadStore;
      for (const account of accounts) yield* store.upsert(row(account));
      const list = yield* List();
      const first = yield* list({ take: 2 });
      expect(first.next).toBe("acct_b");
      const second = yield* list({ take: 2, after: first.next! });
      expect(second.rows.map((entry) => entry.account)).toEqual(["acct_c", "acct_d"]);
      // The binding's in-process form needs no Api and no actor: it reads a
      // rebuildable projection, not a view.
      const all = yield* list();
      expect(all.rows.length).toBe(accounts.length);
      expect(all.next).toBeNull();
    }).pipe(Effect.provide(Layer.mergeAll(MemoryBillingReadStore))),
  );
});
