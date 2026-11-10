---
title: "Route"
description: "Exports `ConsoleRoute`, `reflectRoute`."
---

> **Source:** [`packages/paykit-admin/src/Route.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-admin/src/Route.ts#L50)

## ConsoleRoute

> **Kind:** Primitive

The console's pages. The account id is a path segment and the list's filters
and page cursor are the query, so a refresh or a back button lands on the
same view the operator left:

- `/` — the account list
- `/accounts/:account` — one account, with the list's filters preserved
- `/?standing=grace&tier=pro&after=acct_50` — a filtered page
- `/?search=maya` — searched by name, email or account id
- `/overview` — cross-account revenue and account mix
- `/plans` — the deploy's tiers, read only
- `/features` — the deploy's features, read only

## reflectRoute

> **Kind:** Primitive

The URL a route reflects: what the console pushes after a navigation, so the
address bar names the view. `init` parses the same string back through
`routeOf`, which is what makes a refresh and a back button land correctly.
