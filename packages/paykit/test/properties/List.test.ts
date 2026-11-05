import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  DEFAULT_PAGE,
  MAX_PAGE,
  type BillingReadRow,
  queryRows,
} from "../../src/BillingReadStore.ts";
import { assertProperty } from "../support/Property.ts";

const at = DateTime.makeUnsafe("2030-01-01T00:00:00Z");

const RowSpec = Schema.Struct({
  standing: Schema.Literals(["good", "grace", "blocked"]),
  tier: Schema.Literals(["free", "pro", "scale"]),
  status: Schema.Literals(["trialing", "active", "grace", "canceled", "expired"]),
  credits: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))),
});

const Query = Schema.Struct({
  standing: Schema.optionalKey(Schema.Literals(["good", "grace", "blocked"])),
  tier: Schema.optionalKey(Schema.Literals(["free", "pro", "scale"])),
  status: Schema.optionalKey(
    Schema.Literals(["trialing", "active", "grace", "canceled", "expired"]),
  ),
  order: Schema.optionalKey(Schema.Literals(["asc", "desc"])),
  take: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE + 20 }))),
  ),
  after: Schema.optionalKey(Schema.Literals(["acct_0000", "acct_0003", "acct_0007", "acct_9999"])),
});
type Query = typeof Query.Type;

const ListCase = Schema.Struct({
  rows: Schema.Array(RowSpec).pipe(Schema.check(Schema.isMaxLength(40))),
  query: Query,
});

const row = (account: string, spec: typeof RowSpec.Type): BillingReadRow => ({
  account,
  tier: spec.tier,
  status: spec.status,
  standing: spec.standing,
  periodStart: at,
  periodEnd: at,
  cancelAtPeriodEnd: false,
  credits: spec.credits,
  dunningAttempts: 0,
  features: {},
});

const rowsOf = (specs: ReadonlyArray<typeof RowSpec.Type>): ReadonlyArray<BillingReadRow> =>
  specs.map((spec, index) => row(`acct_${String(index).padStart(4, "0")}`, spec));

const pageSizeOf = (query: Query): number =>
  Math.min(MAX_PAGE, Math.max(1, query.take ?? DEFAULT_PAGE));

const expectedRows = (rows: ReadonlyArray<BillingReadRow>, query: Query) => {
  const matching = rows.filter(
    (entry) =>
      (query.standing === undefined || entry.standing === query.standing) &&
      (query.tier === undefined || entry.tier === query.tier) &&
      (query.status === undefined || entry.status === query.status),
  );
  const order = query.order ?? "asc";
  const sorted = [...matching].sort((left, right) =>
    order === "asc"
      ? left.account.localeCompare(right.account)
      : right.account.localeCompare(left.account),
  );
  return query.after === undefined
    ? sorted
    : sorted.filter((entry) =>
        order === "asc" ? entry.account > query.after! : entry.account < query.after!,
      );
};

describe("list paging", () => {
  it.effect("a cursor walks every matching account once, in order", () =>
    assertProperty(
      Arbitrary.schema(ListCase),
      (input) => {
        const rows = rowsOf(input.rows);
        const query = input.query;
        const expected = expectedRows(rows, query);
        const size = pageSizeOf(query);

        const first = queryRows(rows, query);
        if (first.rows.length > size) return false;
        if (first.rows.length !== Math.min(size, expected.length)) return false;
        if (first.rows.some((entry, index) => entry.account !== expected[index]?.account)) {
          return false;
        }
        const expectedNext = expected.length > size ? expected[size - 1]!.account : null;
        if (first.next !== expectedNext) return false;

        let cursor = first.next;
        let walked = first.rows.length;
        let guard = 0;
        while (cursor !== null) {
          if (guard++ > rows.length + 1) return false;
          const page = queryRows(rows, { ...query, after: cursor });
          if (page.rows.length > size) return false;
          if (
            page.rows.some((entry, index) => entry.account !== expected[walked + index]?.account)
          ) {
            return false;
          }
          walked += page.rows.length;
          cursor = page.next;
        }

        // Every matching account was served exactly once.
        return walked === expected.length;
      },
      { runs: 120, size: 40 },
    ),
  );

  it.effect("a page never exceeds the cap and filters before paging", () =>
    assertProperty(
      Arbitrary.schema(ListCase),
      (input) => {
        const rows = rowsOf(input.rows);
        const page = queryRows(rows, input.query);
        if (page.rows.length > MAX_PAGE) return false;
        if (page.rows.length > pageSizeOf(input.query)) return false;
        return page.rows.every(
          (entry) =>
            (input.query.standing === undefined || entry.standing === input.query.standing) &&
            (input.query.tier === undefined || entry.tier === input.query.tier) &&
            (input.query.status === undefined || entry.status === input.query.status),
        );
      },
      { runs: 80, size: 40 },
    ),
  );
});
