# Agent source mirrors

Shallow git trees for source-first agent work. **Not runtime dependencies.** Populate:

```bash
./scripts/vendor-agent-sources.sh
./scripts/vendor-agent-sources.sh --refresh   # replace existing mirrors
```

Layout: `.agent_sources/github.com/<owner>/<repo>/` with `.agent-source.json` metadata per mirror.
The clones are gitignored; this file is not.

## Inventory

Only the three libraries this repo is built on are vendored. Refs below are derived from the
catalog in `pnpm-workspace.yaml` by `scripts/vendor-agent-sources.sh`; the table records what
that resolves to today.

| Path | Upstream | Ref | Why |
| --- | --- | --- | --- |
| `github.com/Effect-TS/effect` | https://github.com/Effect-TS/effect.git | `effect@4.1.2` | Effect v4 Schema, Context.Service, Config, platform, SQL, `@effect/vitest` |
| `github.com/alchemy-run/alchemy` | https://github.com/alchemy-run/alchemy.git | `v2.0.0-beta.85` | Alchemy resources, Cloudflare and Stripe providers, Effect-native Stack API |
| `github.com/foldkit/foldkit` | https://github.com/foldkit/foldkit.git | `foldkit@0.170.0` | Foldkit UI and its Effect bridge |

The script refuses a pin with no matching upstream tag and fails when a mirror's
`packages/<name>/package.json` disagrees with its pin, so a stale mirror cannot teach old APIs.

Inspect before non-trivial Effect, Alchemy or Foldkit edits. Prefer these mirrors over
`node_modules` for API shape and examples — except an installed package's own `AGENTS.md`,
which ships with the version and is never stale.
