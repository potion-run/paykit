import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { List } from "../../src/Billing/List.binding.ts";
import {
  BillingReadStore,
  DEFAULT_PAGE,
  MAX_PAGE,
  type BillingReadRow,
  queryRows,
} from "../../src/BillingReadStore.ts";
import { catalog } from "../../src/Catalog.ts";
import { standingOf } from "../../src/Subscription/Subscription.state.ts";
import { bindingsWorld } from "../support/Bindings.ts";

const at = Effect.runSync(
  Effect.succeed(new Date("2030-01-01T00:00:00Z")).pipe(Effect.map((date) => date as unknown)),
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
const customerAt = DateTime.makeUnsafe("2030-01-01T00:00:00Z");
const testCatalog = Effect.runSync(catalog({ features: [], tiers: [] }));

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

  it("searches the account id, customer name and customer email", () => {
    const rows = [
      row("acct_a", {
        customer: {
          name: "Maya Chen",
          email: "maya@acme.dev",
          createdAt: customerAt,
        },
      }),
      row("acct_b", {
        customer: {
          name: "Sam Rivera",
          email: "sam@other.dev",
          createdAt: customerAt,
        },
      }),
      row("acct_c"),
    ];

    expect(queryRows(rows, { search: "MAYA" }).rows.map((entry) => entry.account)).toEqual([
      "acct_a",
    ]);
    expect(queryRows(rows, { search: "other.dev" }).rows.map((entry) => entry.account)).toEqual([
      "acct_b",
    ]);
    expect(queryRows(rows, { search: "acct_c" }).rows.map((entry) => entry.account)).toEqual([
      "acct_c",
    ]);
    expect(queryRows(rows, { search: "  " }).rows.length).toBe(3);
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
      // A page is a snapshot, so the binding stamps when it answered. The
      // console shows this instead of presenting the list as live.
      expect(all.asOf).toBeDefined();
    }).pipe(
      Effect.provide(
        // The binding is built from the model, so the world is the model and its
        // store — the same world every other binding test provides.
        bindingsWorld({ catalog: testCatalog }),
      ),
    ),
  );
});
