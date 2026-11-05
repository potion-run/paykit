import type { BillingReadQuery } from "@potion.run/paykit/BillingReadStore";
import {
  AccountId,
  Standing,
  SubscriptionStatus,
} from "@potion.run/paykit/Subscription/Subscription.state";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Route from "foldkit/route";
import type { Url } from "foldkit/url";

/**
 * The server-side filters the list accepts. `OptionFromOptional` rather than
 * `Option` so the same schema is the URL query: an absent key is `None`, and
 * encoding `None` omits the key instead of writing `standing=null`.
 */
const accountFilterFields = {
  standing: Schema.OptionFromOptional(Standing),
  status: Schema.OptionFromOptional(SubscriptionStatus),
  tier: Schema.OptionFromOptional(Schema.String),
} as const;

/** One query filter set, absent meaning "all". */
export const AccountFilter = Schema.Struct(accountFilterFields);
export type AccountFilter = typeof AccountFilter.Type;

/** The filter plus the page cursor, which is what the URL actually carries. */
const routeQueryFields = {
  ...accountFilterFields,
  /** The `next` cursor of the page on screen; absent on the first page. */
  after: Schema.OptionFromOptional(Schema.String),
} as const;

export const RouteQuery = Schema.Struct(routeQueryFields);
export type RouteQuery = typeof RouteQuery.Type;

/** Every account, unfiltered. */
export const noFilter: AccountFilter = {
  standing: Option.none(),
  status: Option.none(),
  tier: Option.none(),
};

/**
 * The console's two pages. The account id is a path segment and the list's
 * filters and page cursor are the query, on both pages, so a refresh or a back
 * button lands on the same view the operator left:
 *
 * - `/` — the account list
 * - `/accounts/:account` — one account, with the list's filters preserved
 * - `/?standing=grace&tier=pro&after=acct_50` — a filtered page
 *
 * @primitive
 */
export const ConsoleRoute = Route.defineRouteUnion({
  Accounts: routeQueryFields,
  Account: { account: AccountId, ...routeQueryFields },
});
export type ConsoleRoute = typeof ConsoleRoute.Type;

const accountsRouter = pipe(
  Route.root,
  Route.query(RouteQuery),
  Route.mapTo(ConsoleRoute.Accounts),
);

const accountRouter = pipe(
  Route.literal("accounts"),
  Route.slash(Route.schemaSegment("account", AccountId)),
  Route.query(RouteQuery),
  Route.mapTo(ConsoleRoute.Account),
);

const routeParser = Route.oneOf(accountRouter, accountsRouter);

const parseRoute = Route.parseUrlWithFallback(routeParser, {
  // An unknown path or an unparseable filter is the unfiltered list, not a
  // crash and not a stale selection.
  make: () => ConsoleRoute.Accounts({ ...noFilter, after: Option.none() }),
});

/** The route a URL names. */
export const routeOf = (url: Url): ConsoleRoute => parseRoute(url);

/** The filter a route carries. */
export const filterOf = (route: ConsoleRoute): AccountFilter => ({
  standing: route.standing,
  status: route.status,
  tier: route.tier,
});

/** The page cursor a route carries: the `next` of the page before it. */
export const afterOf = (route: ConsoleRoute): Option.Option<string> => route.after;

/** The unfiltered, first accounts page. */
export const accountsRoute = (
  filter: AccountFilter,
  after: Option.Option<string> = Option.none(),
): ConsoleRoute => ConsoleRoute.Accounts({ ...filter, after });

/** One account, keeping the list's filters and page. */
export const accountRoute = (
  account: AccountId,
  filter: AccountFilter,
  after: Option.Option<string> = Option.none(),
): ConsoleRoute => ConsoleRoute.Account({ account, ...filter, after });

/** Re-point a route's filters, keeping which page it is and dropping the cursor. */
export const withFilter = (route: ConsoleRoute, filter: AccountFilter): ConsoleRoute =>
  route._tag === "Account" ? accountRoute(route.account, filter) : accountsRoute(filter);

/** Re-point a route's page cursor, keeping its page and filters. */
export const withAfter = (route: ConsoleRoute, after: Option.Option<string>): ConsoleRoute =>
  route._tag === "Account"
    ? accountRoute(route.account, filterOf(route), after)
    : accountsRoute(filterOf(route), after);

/**
 * The URL a route reflects: what the console pushes after a navigation, so the
 * address bar names the view. `init` parses the same string back through
 * `routeOf`, which is what makes a refresh and a back button land correctly.
 *
 * @primitive
 */
export const reflectRoute = (route: ConsoleRoute): string =>
  route._tag === "Account"
    ? accountRouter({ account: route.account, ...filterOf(route), after: route.after })
    : accountsRouter({ ...filterOf(route), after: route.after });

/** The wire query a filter asks the list for. */
export const queryOf = (filter: AccountFilter, after?: string): BillingReadQuery => ({
  ...(Option.isSome(filter.standing) ? { standing: filter.standing.value } : {}),
  ...(Option.isSome(filter.status) ? { status: filter.status.value } : {}),
  ...(Option.isSome(filter.tier) ? { tier: filter.tier.value } : {}),
  ...(after === undefined ? {} : { after }),
});

/** Whether two filters ask for the same rows. */
export const sameFilter = (left: AccountFilter, right: AccountFilter): boolean =>
  Option.getOrUndefined(left.standing) === Option.getOrUndefined(right.standing) &&
  Option.getOrUndefined(left.status) === Option.getOrUndefined(right.status) &&
  Option.getOrUndefined(left.tier) === Option.getOrUndefined(right.tier);

/** Whether two cursors name the same page. */
export const samePage = (left: Option.Option<string>, right: Option.Option<string>): boolean =>
  Option.getOrUndefined(left) === Option.getOrUndefined(right);
