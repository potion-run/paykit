# `@potion.run/website`

The paykit docs site, built with [Blume](https://useblume.dev). It is a
private workspace package, not a published one.

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
├─ blume.config.ts   # site metadata, logo, GitHub links, deployment
├─ docs/             # the authored pages; the folder is the sidebar
└─ alchemy.run.ts    # the Cloudflare static-site stack
```

Navigation is the file tree: `docs/index.mdx` is the landing page and every
other page joins the sidebar automatically. A page's frontmatter `title`
labels it; `sidebar.order` places it. Add a `meta.ts` beside the pages only
when filesystem order is not enough.

## Repo integration

- The workspace is `website/` (root `pnpm-workspace.yaml`), and every
  dependency is a root catalog entry.
- The site is intentionally outside the `tsrs` project-reference graph.
  Blume owns its type check through `blume check`.
- `alchemy.run.ts` is the deploy stack: a `Cloudflare.Website.StaticSite` that
  runs `pnpm build` and serves `dist/` as a static Worker. There is no
  Wrangler config; the repo's deploy path is Alchemy.
- `deployment.site` in `blume.config.ts` is still the placeholder; set it to
  the production origin before the first deploy so canonical URLs, the
  sitemap, Open Graph images, and `llms.txt` point at the right site.
- Blume's own guidance ships in `node_modules/blume/docs/`. Run
  `npx blume --help` for the CLI.
