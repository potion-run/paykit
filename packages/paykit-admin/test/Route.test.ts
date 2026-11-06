import { describe, expect, it } from "@alchemy.run/test";
import { AccountId } from "@potion.run/paykit";
import * as Option from "effect/Option";
import type { Url } from "foldkit/url";
import {
  AccountFilter,
  accountRoute,
  accountsRoute,
  afterOf,
  ConsoleRoute,
  noFilter,
  reflectRoute,
  routeOf,
  withAfter,
  withFilter,
} from "../src/Route.ts";

const url = (pathname: string, search?: string): Url => ({
  protocol: "https:",
  host: "admin.test",
  port: Option.none(),
  pathname,
  search: Option.fromNullishOr(search),
  hash: Option.none(),
});

/** Split an href the way the runtime's `Url` does, then parse it as a route. */
const routeOfHref = (href: string): ConsoleRoute => {
  const parsed = new URL(href, "https://admin.test");
  const search = parsed.search.replace(/^\?/, "");
  return routeOf(url(parsed.pathname, search === "" ? undefined : search));
};

const account = AccountId.make("acct_a");

const filter = (overrides: Partial<AccountFilter> = {}): AccountFilter => ({
  ...noFilter,
  ...overrides,
});

describe("the console route", () => {
  it("round-trips every page through the URL it reflects", () => {
    const routes: ReadonlyArray<ConsoleRoute> = [
      accountsRoute(noFilter),
      accountsRoute(filter({ standing: Option.some("grace") })),
      accountsRoute(filter({ status: Option.some("canceled"), tier: Option.some("pro") })),
      accountsRoute(noFilter, Option.some("acct_b")),
      accountRoute(account, noFilter),
      accountRoute(account, filter({ standing: Option.some("blocked") })),
      accountRoute(account, noFilter, Option.some("acct_b")),
      ConsoleRoute.Overview(),
      ConsoleRoute.Plans(),
      ConsoleRoute.Features(),
    ];
    for (const route of routes) {
      expect(routeOfHref(reflectRoute(route))).toEqual(route);
    }
  });

  it("names the account in the path and the filters in the query", () => {
    expect(reflectRoute(accountsRoute(noFilter))).toBe("/");
    expect(reflectRoute(accountsRoute(filter({ standing: Option.some("grace") })))).toBe(
      "/?standing=grace",
    );
    expect(reflectRoute(accountRoute(account, filter({ tier: Option.some("pro") })))).toBe(
      "/accounts/acct_a?tier=pro",
    );
    // The page cursor is in the URL too, so a refresh keeps the page.
    expect(reflectRoute(accountsRoute(noFilter, Option.some("acct_b")))).toBe("/?after=acct_b");
    expect(afterOf(accountsRoute(noFilter, Option.some("acct_b")))).toEqual(Option.some("acct_b"));
    expect(reflectRoute(ConsoleRoute.Overview())).toBe("/overview");
    expect(reflectRoute(ConsoleRoute.Plans())).toBe("/plans");
    expect(reflectRoute(ConsoleRoute.Features())).toBe("/features");
  });

  it("keeps the filters when the page changes, and the page when the filters do", () => {
    const filtered = accountsRoute(filter({ standing: Option.some("grace") }));
    const opened = withFilter(filtered, noFilter);
    expect(opened).toEqual(accountsRoute(noFilter));

    const accountPage = accountRoute(account, filter({ tier: Option.some("pro") }));
    expect(withFilter(accountPage, filter({ status: Option.some("active") }))).toEqual(
      accountRoute(account, filter({ status: Option.some("active") })),
    );
  });

  it("drops the page cursor when a filter changes, and keeps the page on a new cursor", () => {
    const paged = accountRoute(
      account,
      filter({ tier: Option.some("pro") }),
      Option.some("acct_b"),
    );
    // A cursor from another filter names a row that filter may not have.
    expect(withFilter(paged, filter({ standing: Option.some("grace") }))).toEqual(
      accountRoute(account, filter({ standing: Option.some("grace") })),
    );
    // A new cursor keeps the page and the filters.
    expect(withAfter(paged, Option.none())).toEqual(
      accountRoute(account, filter({ tier: Option.some("pro") })),
    );
  });

  it("falls back to the unfiltered list for an unknown path or filter", () => {
    expect(routeOf(url("/nope"))).toEqual(accountsRoute(noFilter));
    expect(routeOf(url("/", "standing=bogus"))).toEqual(accountsRoute(noFilter));
    expect(routeOf(url("/accounts/acct_a", "status=bogus"))).toEqual(accountsRoute(noFilter));
  });
});
