# @potion.run/polar

Polar for Alchemy: products, prices and webhook endpoints as resources, checkout, customer
session and refund as bindings, over `@distilled.cloud/polar`.

A general Alchemy provider. It never imports `@potion.run/paykit`, and paykit-specific helpers do
not land here — its README is a Worker that sells a product with no paykit import, and its tests
run without paykit installed.

## Surface

| Kind | Exports |
| --- | --- |
| Resources | `Product` with its prices, `WebhookEndpoint` |
| Bindings | `CreateCheckoutSession`, `CreateCustomerSession`, `CreateRefund`, `ConsumeEvents` |

Polar embeds prices in the product, so `Product` is the reconciliation unit. Do not copy Stripe's
split `Product` / `Price` shape onto it.

## Rules

- The engine, reconciler and binding conventions are Alchemy's:
  [AGENTS.md](https://github.com/alchemy-run/alchemy/blob/main/AGENTS.md). Read the Reconciler
  doctrine before writing `Diff` / `Read` / `Reconcile` / `Delete`.
- One file per resource or capability, contract and provider co-located, an `*Http` implementation
  per binding.
- Typed errors come from `@distilled.cloud/polar`. Matching a status code or a bare `_tag` string
  means the patch is missing upstream — fix it there, not with a cast here.
- Live tests: create, update, replace, delete against the real API, deterministic names, verify
  through a distilled read, destroy at the end. A suite that leaks a product is failing.
- `alchemy` and `effect` are peers; `@distilled.cloud/polar` is a dependency. The package
  publishes on the repo's version line, and paykit takes it as an optional peer.

## Further reading

- [Root AGENTS.md](../../AGENTS.md) — workspace, versioning, Effect discipline, gates.
- [@alchemy.run/stripe](https://github.com/alchemy-run/alchemy/tree/main/packages/stripe) — the
  package this one mirrors.
