# 0003 — The deploy provisions the vendor, from the catalog

- **Status:** Accepted
- **Date:** 2026-11-04
- **Supersedes:** none
- **Follows:** [0001](./0001-catalog-states-the-pricing-model.md), [0002](./0002-credits-are-the-unit-of-account.md)

## Context

ADR 0001 decided that the deploy provisions the vendor: the products, prices and webhook endpoint a
provider needs come from the catalog, not from a person in a dashboard. The catalog is the only place
a price is stated, and today it is checked against the vendor *afterwards* — `CatalogPriceMismatch`
proves the two agree without ever having set one. A user still creates prices in Stripe by hand,
pastes the ids into a config, and finds out at deploy that they do not match.

The pieces exist: Alchemy reconciles resources, `@alchemy.run/stripe` already ships a `Product` and a
`Price` resource with ownership metadata, adoption and drift handling, and `paykit-stripe` already
maps a tier to a price id. What is missing is the join.

## Decision

**1. The user's stack declares the vendor resources; paykit returns them.** A paykit helper takes the
catalog's prices and yields the vendor resources, returning the tier → vendor id map the provider
config wants. paykit does not create resources behind the user's back, and `BillingStack` keeps doing
what it does — validate and record.

```ts
const prices = yield* StripePrices("Prices", { tiers: { pro: proPrice, scale: scalePrice } });

yield* Paykit.Stack("Billing", {
  providers: [
    Stripe({
      secretKey: yield* Config.redacted("STRIPE_SECRET_KEY"),
      origin,
      webhookSecret: yield* Config.redacted("STRIPE_WEBHOOK_SECRET"),
      tiers: {
        pro: { price: proPrice, priceId: prices.pro.priceId },
        scale: { price: scalePrice, priceId: prices.scale.priceId },
      },
    }),
  ],
  catalog,
});
```

**2. Identity is the stage and the tier, carried in the vendor's own field.** A Stripe price is
found by `lookup_key = "paykit:<stage>:<tier>"`; a Polar product carries
`metadata.paykit_tier = "<tier>"`. The vendor id is a cache of that, never the identity, so a
database restored from a backup reconciles to the same vendor objects instead of duplicating them.

The stage is part of the key because shares are not isolated by the vendor: every stage on one key
pair shares one Stripe account, and `transfer_lookup_key` would let a `preview` price take the
lookup key from `prod`'s — a production checkout charging the preview amount.

**3. A price is financial history, so it is never deleted.** Three rules:

- **Create** when no price carries the tier's lookup key.
- **Replace** when the amount, currency or interval changes: Alchemy creates the new price and
  moves the lookup key onto it (`transfer_lookup_key`), because Stripe prices are immutable and a
  live subscription must not change what it is charged.
- **Retire** when a tier leaves the catalog or stops being priced: the resources are declared with
  `RemovalPolicy.retain`, so the Stripe object is left alone and only the state row goes away.

**Retention is not archival.** A retired price is left active, not archived: archiving is a vendor
write against a resource the stack no longer tracks, so it needs its own mechanism (a sweep by
lookup-key prefix, or a provider `delete` that archives instead of destroying). Until then the rule
is "never deleted", and `StripePrices` says exactly that rather than claiming a state it does not
produce.

**4. Reuse the vendor package that exists; write the one that does not.** For Stripe, `StripePrices`
yields `@alchemy.run/stripe`'s `Product` and `Price` resources — they already tag ownership, adopt
existing objects and refuse a foreign one. For Polar, which has no Alchemy package, `paykit-polar`
grows a `Product` resource of its own with the same three rules and the same metadata convention.

**5. The catalog stays provider-free.** The helper takes prices, not tiers with vendor fields, and
returns ids. Nothing about Stripe appears in the catalog, and a stack that runs two providers
declares two sets of resources from the same prices.

## Slices

### 2a — Stripe prices

`StripePrices(id, { tiers })` in `packages/paykit-stripe`: one `Product` per tier (named after it,
`metadata.paykit_tier`), one `Price` per tier (`lookup_key = "paykit:<tier>"`,
`recurring.interval` from the catalog's `month | annual` → `month | year`), output
`Record<tier, { productId, priceId }>`. A pure `priceDeclarations(tiers)` returns the ids, lookup keys
and amounts so the mapping is testable without a network.

### 2b — the webhook endpoint and its secret

A `WebhookEndpoint` resource that reconciles the delivery URL and reports the signing secret as a
`Redacted` output, so `webhookSecret` stops being something a person pastes in. Deferred: it needs a
decision about where the secret is stored, and a secret in Terraform-style state is a different
threat model from a price id.

### 2c — Polar products

The same three rules over `@distilled.cloud/polar`, once 2a has settled the shape.

## Consequences

- **A deploy can now fail for a vendor reason.** A price that cannot be created fails the deploy, and
  that is the point: the alternative is a checkout that cannot be paid.
- **Deploy time grows by one vendor call per priced tier**, once, and stays zero at request time.
- **The vendor package depends on Alchemy.** `paykit-stripe` gains `alchemy` and `@alchemy.run/stripe`
  as peers, because a resource needs the engine. It stays a paykit package: what it adds is the join
  from catalog to resources, not a second Stripe resource.
- **`CatalogPriceMismatch` becomes a backstop rather than the gate.** With prices created from the
  catalog, a mismatch means someone edited the vendor by hand; the deploy still refuses it.
- **Retained prices accumulate.** A stage that changes a price monthly leaves a trail of archived
  prices. That is the desired record, but a console should be able to list them.

## Alternatives considered

- **Have `BillingStack` create the vendor resources itself.** Rejected: it would make paykit import
  every provider package, and a resource that another resource created behind the user's back has no
  place in their state tree to be inspected.
- **Write our own Stripe `Price` resource on `@distilled.cloud/stripe`.** Rejected: `@alchemy.run/stripe`
  already does ownership, adoption and drift, and a second implementation would be a fork that drifts.
- **Update a price in place.** Rejected: Stripe prices are immutable by design, and pretending
  otherwise would silently move what a live subscription is charged.
- **Delete a retired price.** Rejected: invoices reference it, and a financial record is not cleaned
  up.

## What would reopen this

A second price per tier — a monthly and an annual price on one tier, or a seat price alongside a
usage price. That is a list of prices per tier rather than one, and it would extend this record
instead of replacing it.
