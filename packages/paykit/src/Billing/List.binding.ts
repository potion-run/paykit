import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { BillingReadPage, BillingReadQuery } from "../BillingReadStore.ts";
import { type BindingError, oneOf, toBindingError } from "./Bindings.ts";

/** Every refusal a cross-account page can answer. It is unguarded by design. */
export type ListRefusal = never;
export type ListError = BindingError<ListRefusal>;

/** A page never refuses; the tool has no guard, so there is nothing to narrow. */
export const isListRefusal = oneOf<ListRefusal>([]);

/** A layer's own failure, as this binding's declared union. */
export const toListError = toBindingError("Paykit.List", isListRefusal);

/** The verb of a bound `List`. Deployment-scoped, so it takes no account. */
export type ListVerb = (query?: BillingReadQuery) => Effect.Effect<BillingReadPage, ListError>;

/**
 * One page of accounts, in a stable cursor order. This is the only read that
 * spans accounts — a view folds one key — so a dashboard, a past-due list and an
 * export all page through here.
 *
 * `after` is the cursor a previous page returned in `next`, so a row created or
 * closed between two pages shifts nothing. A page is a snapshot: it says when it
 * was read (`asOf`), so a console can label it as point-in-time.
 *
 * The bind takes nothing, because the scope is the deployment and not an
 * account — the one shape that is not `(account) => verb`.
 *
 * ### Paging past-due accounts
 * **Example:** Walk every account in grace, two pages at a time
 * ```typescript
 * const list = yield* Paykit.List();
 * let cursor: string | null = null;
 * do {
 *   const page = yield* list({ standing: "grace", take: 100, ...(cursor === null ? {} : { after: cursor }) });
 *   cursor = page.next;
 * } while (cursor !== null);
 * ```
 *
 * @binding
 * @product Console
 * @provides Paykit.List
 */
export interface List extends Binding.Service<List, "Paykit.List", () => Effect.Effect<ListVerb>> {}

export const List = Binding.Service<List>("Paykit.List");
