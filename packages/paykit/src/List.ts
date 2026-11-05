import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  type BillingReadPage,
  type BillingReadQuery,
  BillingReadStore,
  MAX_PAGE,
  queryRows,
} from "./BillingReadStore.ts";

/**
 * One page of accounts, in a stable cursor order. This is the only read that
 * spans accounts: a `View` folds one key, so a dashboard, a past-due list and
 * an export all page through here.
 *
 * `after` is the cursor a previous page returned in `next`, so an account
 * created or closed between two pages shifts no row. `take` defaults to 50 and
 * never exceeds 200.
 *
 * A cross-account list is a binding rather than an `Api` read because an Api
 * serves keyed reads; expose it through your own route, your console, or a
 * command you add deliberately.
 *
 * A page is a snapshot, so the page says when it was read (`asOf`). That stamp
 * is the read's answer time, taken here rather than in the store: a store that
 * pages rows answers data, and this binding is what turns the answer into a
 * page a console can label as point-in-time.
 *
 * ### Paging past-due accounts
 * **Example:** Walk every account in grace, two pages at a time
 * ```typescript
 * const list = yield* Paykit.List();
 * let cursor: string | null = null;
 * do {
 *   const page = yield* list({ standing: "grace", take: 100, ...(cursor === null ? {} : { after: cursor }) });
 *   for (const row of page.rows) console.log(row.account, row.periodEnd);
 *   cursor = page.next;
 * } while (cursor !== null);
 * ```
 *
 * @primitive
 */
export const List = Effect.fn("Paykit.List")(function* () {
  const store = yield* BillingReadStore;
  return Effect.fn("Paykit.List.page")(function* (query?: BillingReadQuery) {
    const page = yield* store.list(query);
    return {
      ...page,
      asOf: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
    } satisfies BillingReadPage;
  });
});

export { MAX_PAGE, queryRows };
