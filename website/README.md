# `@potion.run/website`

The paykit docs site, built with [Blume](https://useblume.dev). It is a
private workspace package, not a published one.

Live at [https://paykit.32stack.com](https://paykit.32stack.com).

## Run it

From the repo root:

```sh
pnpm dev:website      # Blume dev server
pnpm build:website    # static output in website/dist
pnpm check:website    # type-check and validate links and anchors
```

Or from `website/`:

```sh
pnpm dev       # dev server with hot reload
pnpm build     # static build in dist/
pnpm check     # type-check the docs site
pnpm validate  # check internal links, anchors, and assets
pnpm run doctor  # diagnose config and content problems
```

## Layout

```
website/
├─ blume.config.ts   # site metadata, theme, redirects, deployment
├─ docs/             # the authored pages; a folder is a sidebar section
│  ├─ index.mdx      # the hub
│  ├─ what-is-paykit.mdx
│  ├─ getting-started.mdx
│  ├─ concepts/      # pricing models, features, plans, subscriptions, balances, credits
│  ├─ runtime/       # check, track usage, holds, commands
│  ├─ providers/     # overview, manual, stripe, polar
│  ├─ hosting/       # database, auth
│  └─ reference/     # packages
└─ alchemy.run.ts    # the Cloudflare static-site stack
```

Navigation is the file tree: `docs/index.mdx` is the landing page and every
other page joins the sidebar automatically. Each section's `meta.ts` sets the
group title, icon and page order. A page's frontmatter `title` labels it, and
`sidebar.order` places a root page.

New pages follow the page shapes in [AGENT.md](./AGENT.md), and a moved page
needs a redirect in `blume.config.ts`.

## Repo integration

- The workspace is `website/` (root `pnpm-workspace.yaml`), and every
  dependency is a root catalog entry.
- The site is intentionally outside the `tsrs` project-reference graph.
  Blume owns its type check through `blume check`.
- `alchemy.run.ts` is the Alchemy deploy stack: a `Cloudflare.Website.StaticSite` that
  runs `pnpm build` and serves `dist/` as a static Worker.
- `wrangler.toml` is the Cloudflare dashboard deploy: a static-asset Worker serving
  `dist/`. Dashboard settings are Root directory `/`, Build
  `pnpm --filter @potion.run/website build`, Deploy
  `npx wrangler deploy --config website/wrangler.toml`.
- `deployment.site` in `blume.config.ts` is the production origin
  (`https://paykit.32stack.com`); it drives canonical URLs, the
  sitemap, Open Graph images, and `llms.txt`.
- Blume's own guidance ships in `node_modules/blume/docs/`. Run
  `npx blume --help` for the CLI.
