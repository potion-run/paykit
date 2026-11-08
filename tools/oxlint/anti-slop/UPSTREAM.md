# Vendored anti-slop Oxlint plugins

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), installed from the
`install-anti-slop` skill (`npx skills add dmmulroy/anti-slop --skill install-anti-slop`). The
pristine snapshot is the skill bundle's `assets/anti-slop/`, recorded in the root
`skills-lock.json` under the `install-anti-slop` entry (SKILL.md hash
`1b9b5d3c0d9e0ef8dd7631f4d637e66b62a73e34dceaf4ae07c0d3de376fd7d7`). The files in this directory
are copied verbatim from that snapshot; `diff -r` between the two is empty.

Installed entry points:

- `index.ts` — the generic plugin, registered as `anti-slop`.
- `effect/index.ts` — the opt-in Effect plugin, registered as `anti-slop-effect`.

The rules import `@oxlint/plugins`, pinned to the installed `oxlint` version (1.91.0) in the root
`pnpm-workspace.yaml` catalog, because the two are one API.

## Local policy

The rules are registered in `oxlint.config.ts`. Every generic rule is at `error` except the ones
whose advice does not describe this repository; the reason is recorded beside each in that file.
The Effect plugin is on because every workspace package depends on `effect` directly.

`test/` overrides several anti-slop rules. Property tests construct intentionally invalid states,
assert the exact tagged value they got back and widen an arbitrary into the domain type it
generated; that is fixture setup, not production shape. The same override already existed for the
`effecttsgo` type-assertion rule.

## Updating

Follow the skill's update procedure (`references/update.md` in the skill): stage the new bundle,
three-way merge against this directory, review rule behavior and configuration separately, and
record the incoming snapshot here. Do not replace the directory wholesale.

## Verification

`pnpm lint` loads both plugins through their TypeScript entry points; `pnpm typecheck` covers the
application code the rules report on. `vendor/eslint-stylistic/LICENSE` and
`vendor/eslint-stylistic/UPSTREAM.md` travel with the vendored padding-line rule and must be
retained in any redistribution, including the skill assets.
