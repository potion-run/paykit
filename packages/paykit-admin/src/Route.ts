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

/** Every account, unfiltered. */
export const noFilter: AccountFilter = {
  standing: Option.none(),
  status: Option.none(),
  tier: Option.none(),
};

/**
 * The console's two pages. The account id is a path segment and the list's
 * filters are the query, on both pages, so a refresh or a back button lands on
 * the same view the operator left:
 *
 * - `/` — the account list
 * - `/accounts/:account` — one account, with the list's filters preserved
 * - `/?standing=grace&tier=pro` — a filtered list
 *
 * @primitive
 */
export const ConsoleRoute = Route.defineRouteUnion({
  Accounts: accountFilterFields,
  Account: { account: AccountId, ...accountFilterFields },
});
export type ConsoleRoute = typeof ConsoleRoute.Type;

const accountsRouter = pipe(
  Route.root,
  Route.query(AccountFilter),
  Route.mapTo(ConsoleRoute.Accounts),
);

const accountRouter = pipe(
  Route.literal("accounts"),
  Route.slash(Route.schemaSegment("account", AccountId)),
  Route.query(AccountFilter),
  Route.mapTo(ConsoleRoute.Account),
);

const routeParser = Route.oneOf(accountRouter, accountsRouter);

const parseRoute = Route.parseUrlWithFallback(routeParser, {
  // An unknown path or an unparseable filter is the unfiltered list, not a
  // crash and not a stale selection.
  make: () => ConsoleRoute.Accounts(noFilter),
});

/** The route a URL names. */
export const routeOf = (url: Url): ConsoleRoute => parseRoute(url);

/** The filter a route carries. */
export const filterOf = (route: ConsoleRoute): AccountFilter => ({
  standing: route.standing,
  status: route.status,
  tier: route.tier,
});

/** The unfiltered accounts page. */
export const accountsRoute = (filter: AccountFilter): ConsoleRoute =>
  ConsoleRoute.Accounts({ ...filter });

/** One account, keeping the list's filters. */
export const accountRoute = (account: AccountId, filter: AccountFilter): ConsoleRoute =>
  ConsoleRoute.Account({ account, ...filter });

/** Re-point a route's filters, keeping which page it is. */
export const withFilter = (route: ConsoleRoute, filter: AccountFilter): ConsoleRoute =>
  route._tag === "Account" ? accountRoute(route.account, filter) : accountsRoute(filter);

/**
 * The URL a route reflects: what the console pushes after a navigation, so the
 * address bar names the view. `init` parses the same string back through
 * `routeOf`, which is what makes a refresh and a back button land correctly.
 *
 * @primitive
 */
export const reflectRoute = (route: ConsoleRoute): string =>
  route._tag === "Account"
    ? accountRouter({ account: route.account, ...filterOf(route) })
    : accountsRouter(filterOf(route));

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
