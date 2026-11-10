# This Blume docs site

## In the paykit repo

- The package is `@potion.run/website`, private, and the workspace is
  `website/` in the root `pnpm-workspace.yaml`. Every dependency is a root
  catalog entry.
- Run the site from the repo root with `pnpm dev:website`, `pnpm build:website`
  and `pnpm check:website`. `blume check` owns the typecheck; this workspace is
  intentionally outside the `tsrs` project-reference graph.
- `deployment.site` in `blume.config.ts` is still the placeholder. Set it to
  the production origin before the first deploy.

> `CLAUDE.md` delegates here. Keep project instructions canonical in this file.

## Writing docs

Content lives in `docs/`. Every `.md`/`.mdx` file is a page and the folder tree
is the sidebar, so there is no navigation file to keep in step.

- Frontmatter is strict. `title` and `description` are the common pair;
  `sidebar.order` places a page. Unknown keys fail the build. The full schema
  is in `node_modules/blume/docs/content/frontmatter.mdx`.
- A page's `title` renders as its H1. Do not repeat an H1 in the body; start
  at `##`.
- Blume's components need no imports: `Steps`/`Step`, `Card`/`CardGroup`,
  `Tabs`/`Tab`, `Accordion`, `FileTree`, `Frame`, `Badge`, `Icon`, and more.
  Callouts are directives in `.mdx`:

  ```mdx
  :::tip[The design of record]
  The decisions live in the ADRs.
  :::
  ```

- Directives, `package-install` fences, math, and mermaid are MDX-only. A
  `.md` page that needs one must be renamed to `.mdx` with `git mv` so its
  history follows.
- Icons are kebab-case [Lucide](https://lucide.dev) names, never Phosphor or
  FontAwesome.

### Page shapes

The site follows the Alchemy docs' shapes. Pick one before writing, and do not
mix two on one page:

- **Hub** (`docs/index.mdx`): what the product is, a link to What is Paykit?, a
  quick example, where to start, and one card per section. It states the
  product, not the model.
- **What is** (`what-is-paykit.mdx`): one `##` per concept, in the order a
  newcomer meets them, each with the smallest snippet and a link to its
  chapter. It ends by mapping the concepts to types.
- **Concept chapter** (`catalog/plans.mdx`, `entitlement/check.mdx`): what the
  thing is in a paragraph, one `##` per capability with a snippet, then what it
  refuses, then links onward.
- **Provider page** (`providers/stripe.mdx`): what the vendor owns, the deploy
  half, the runtime half, deliveries, and the example to run.
- **Task guide** (`billing-page.mdx`): a job the reader has, as numbered
  sections. Each section shows the call, says what the customer sees, and ends.
  No teaching, no background.

Sections are ordered by reader concern: Concepts, Runtime, Providers, Hosting,
Reference. The folder is the group and `meta.ts` sets its title, icon
and page order. Root pages list above the groups, so `sidebar.order` on a root
page and on a group share one namespace: keep root pages at 0-9 and groups at
10 and up.

### Writing rules

These came from review:

- Open on the subject, never on the page. No "this page explains".
- One thought per sentence. Put the condition before the step.
- Code first. A section that names a resource or command shows its snippet.
- Title a code block with its file when it is a whole file.
- Every symbol in prose exists in `packages/`. Check a claim about behavior
  against the source or the ADR before writing it.
- End a page with the links that go deeper.
- When you move a page, add a redirect in `blume.config.ts` and update the
  links that pointed at it.

## Commands

| What | Command |
| --- | --- |
| Dev server | `pnpm dev` |
| Production build | `pnpm build` |
| Type-check the site | `pnpm check` |
| Check links and anchors | `pnpm validate` |
| Diagnose config/content | `pnpm run doctor` |
| List CLI commands | `npx blume --help` |

## Blume reference

The installed package carries its own docs and agent skills. Resolve the
package first; in this workspace it lives under `website/node_modules/blume`.

```sh
node -e "console.log(require.resolve('blume/package.json'))"
```

Read `docs/configuration/index.mdx` for `blume.config.ts`, the `docs/content/`
folder for authoring and components, and `docs/discoverability/` for
`llms.txt`, Open Graph images, and the MCP endpoint.
