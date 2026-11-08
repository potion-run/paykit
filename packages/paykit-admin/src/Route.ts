import {
  type BillingReadQuery,
  AccountId,
  Standing,
  SubscriptionStatus,
} from "@potion.run/paykit/Read";
import { pipe } from "effect/Function";
import * as Match from "effect/Match";
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
 * The console's pages. The account id is a path segment and the list's filters
 * and page cursor are the query, so a refresh or a back button lands on the
 * same view the operator left:
 *
 * - `/` — the account list
 * - `/accounts/:account` — one account, with the list's filters preserved
 * - `/?standing=grace&tier=pro&after=acct_50` — a filtered page
 * - `/overview` — cross-account revenue and account mix
 * - `/plans` — the deploy's tiers, read only
 * - `/features` — the deploy's features, read only
 *
 * @primitive
 */
export const ConsoleRoute = Route.defineRouteUnion({
  Accounts: routeQueryFields,
  Account: { account: AccountId, ...routeQueryFields },
  Overview: {},
  Plans: {},
  Features: {},
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

const overviewRouter = pipe(Route.literal("overview"), Route.mapTo(ConsoleRoute.Overview));

const plansRouter = pipe(Route.literal("plans"), Route.mapTo(ConsoleRoute.Plans));

const featuresRouter = pipe(Route.literal("features"), Route.mapTo(ConsoleRoute.Features));

const routeParser = Route.oneOf(
  accountRouter,
  overviewRouter,
  plansRouter,
  featuresRouter,
  accountsRouter,
);

const parseRoute = Route.parseUrlWithFallback(routeParser, {
  // An unknown path or an unparseable filter is the unfiltered list, not a
  // crash and not a stale selection.
  make: () => ConsoleRoute.Accounts({ ...noFilter, after: Option.none() }),
});

/** The route a URL names. */
export const routeOf = (url: Url): ConsoleRoute => parseRoute(url);

/** The filter a route carries. Catalog pages show no account list, so they carry none. */
export const filterOf = (route: ConsoleRoute): AccountFilter =>
  route._tag === "Accounts" || route._tag === "Account"
    ? { standing: route.standing, status: route.status, tier: route.tier }
    : noFilter;

/** The page cursor a route carries: the `next` of the page before it. */
export const afterOf = (route: ConsoleRoute): Option.Option<string> =>
  route._tag === "Accounts" || route._tag === "Account" ? route.after : Option.none();

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
  Match.value(route).pipe(
    Match.tag("Account", (current) => accountRoute(current.account, filter)),
    Match.tag("Accounts", () => accountsRoute(filter)),
    Match.orElse(() => route),
  );

/** Re-point a route's page cursor, keeping its page and filters. */
export const withAfter = (route: ConsoleRoute, after: Option.Option<string>): ConsoleRoute =>
  Match.value(route).pipe(
    Match.tag("Account", (current) => accountRoute(current.account, filterOf(current), after)),
    Match.tag("Accounts", () => accountsRoute(filterOf(route), after)),
    Match.orElse(() => route),
  );

/**
 * The URL a route reflects: what the console pushes after a navigation, so the
 * address bar names the view. `init` parses the same string back through
 * `routeOf`, which is what makes a refresh and a back button land correctly.
 *
 * @primitive
 */
export const reflectRoute = (route: ConsoleRoute): string => {
  switch (route._tag) {
    case "Account":
      return accountRouter({ account: route.account, ...filterOf(route), after: route.after });
    case "Accounts":
      return accountsRouter({ ...filterOf(route), after: route.after });
    case "Overview":
      return overviewRouter();
    case "Plans":
      return plansRouter();
    case "Features":
      return featuresRouter();
  }
};

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
