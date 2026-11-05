# `@potion.run/website`

The paykit docs site, scaffolded with
[`@cloudflare/create-nimbus-docs`](https://nimbus-docs.com). It is an Astro app
built on Nimbus docs, not a published package.

## Run it

From the repo root:

```sh
pnpm dev:website     # Astro dev server
pnpm build:website   # static output in website/dist
pnpm check:website   # Nimbus preflight (structure, authoring, types)
```

`pnpm --filter @potion.run/website typecheck` runs `astro check` over the
Astro/TypeScript files.

## Repo integration

- The workspace is `website/` (root `pnpm-workspace.yaml`), and every dependency
  is a root catalog entry. Nimbus's generated nested `pnpm-workspace.yaml` was
  removed so the repo keeps one workspace root.
- The site is intentionally outside the `tsrs` project-reference graph. Astro
  owns its typecheck (`astro check`), which is why the root `tsconfig.json` does
  not reference it.
- `typescript` is pinned to `^5.8.3` locally: `@astrojs/check` and the Volar
  language server require TypeScript `<7`, while the rest of the repo tracks
  TypeScript 7. Every other dependency is `catalog:`.
- `alchemy.run.ts` is the deploy stack: a `Cloudflare.Website.StaticSite` that
  runs `pnpm build` and serves `dist/` as a static Worker. There is no Wrangler
  config; the repo's deploy path is Alchemy. The `site` value in
  `astro.config.ts` is still the Nimbus placeholder; set it to the production
  origin before the first deploy.
- Content lives in `website/src/content/docs/`. Nimbus's own
  [`AGENT.md`](./AGENT.md) is the authoring guide.
