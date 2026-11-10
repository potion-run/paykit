---
title: "CatalogGuard"
description: "Exports `CatalogGuard`, `CatalogGuardLive`."
---

> **Source:** [`packages/paykit/src/CatalogGuard.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/CatalogGuard.ts#L345)

## CatalogGuard

> **Kind:** Primitive

The guard that keeps the log honest about money. A `Subscribe`,
`ChangeTier` or `StartTrial` carries the allowances and the price it will
record, because `decide` is pure and cannot look them up. A caller that
omits the price, or sends allowances its tier does not grant, is refused
with `CatalogMismatch` instead of writing a standing that can never be
reconciled against an invoice.

A plan the catalog declares with `custom: true` is the one exception, and it
is the catalogue's choice rather than the caller's (ADR 0041): its `grants`
are a default, so a bespoke set is accepted when every item is one the
catalog could have declared for that plan. Its price may likewise be the
negotiated price the command states, because a custom plan is where a
deployment opted into deals the catalog cannot enumerate (ADR 0042 §3). The
credit terms are still compared exactly for a custom plan, so a bespoke deal
changes what a customer may use and pay, never the pool or the rates the
deployment's catalog states.

A catalog-owning sender — `Paykit.Subscribe`, the webhook translator — builds
the command from `CatalogService` and never needs this guard. It exists for
the surfaces where the caller is not the catalog's owner: HTTP, an MCP tool,
a CLI.

### Guarding a catalog-derived command

```typescript
export class Subscribe extends Domain.Command("Subscribe", {
  target: AccountId,
  input: { tier: Schema.String, allowances: Allowances, price: Schema.optionalKey(Price) },
  events: [SubscriptionActivated],
  rejects: [PlanNotInCatalog, CurrencyMismatch, CatalogMismatch],
  middleware: [Session, CatalogGuard],
}) {}
```

## CatalogGuardLive

> **Kind:** Layer

The guard's Layer: it reads the catalog the deployment validated and refuses
what disagrees with it.
