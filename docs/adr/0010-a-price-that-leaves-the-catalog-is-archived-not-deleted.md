# 0010 — A price that leaves the catalog is archived, not deleted

- **Status:** Accepted
- **Date:** 2026-11-05
- **Follows:** [0003](./0003-the-deploy-provisions-the-vendor.md), [0008](./0008-a-report-names-the-price-each-unit-was-recorded-at.md)

## Context

Every price and product a deploy creates is declared with `RemovalPolicy.retain`, so a tier that leaves
the catalog is left in place and only Alchemy's state row goes away. That is deliberate: a bill that
was already sent has to stay reproducible, and ADR 0003's rule is that nothing a bill references is
deleted.

What it does not do is stop the price being *sold*. A Stripe price detached from a stack is still
`active: true`, and a Polar product detached from a stack is still purchasable. So a retired tier keeps
its checkout entry point, and a customer can buy something the catalog no longer offers — at a price
nothing reconciles any more.

Archiving is the missing half: the vendor write that turns a retained price off without deleting it.
It is a write against a resource the stack no longer tracks, which is why the deploy does not do it by
itself.

## Decision

**1. Archiving is a sweep, keyed by identity the stage already owns.** The vendor is asked what it
holds, and the answer is narrowed to what this stage owns:

- Stripe: every price whose lookup key starts with `paykit:<stage>:`.
- Polar: every product whose name starts with `paykit:<stage>:` and whose `paykit_tier` metadata is
  set.

Neither is a new convention. `lookupKeyOf` and `productNameOf` already put the stage in the identity —
so two stacks share one vendor account without reconciling each other's prices — and the trailing
colon is what stops `prod` matching `production`.

**2. The decision is a pure function of the catalog and what the vendor holds.** `retiredPrices` takes
the price declarations and the prices found, and returns the ones to archive: ours, still `active`, and
not among the lookup keys the catalog declares.

```ts
const retired = retiredPrices(priceDeclarations(tiers, stage), found, stage);
```

It lives beside `priceDeclarations` because it is the same kind of thing: the part of the work that
needs no network, tested against a fixture rather than an account.

**3. What is archived is what the catalog stopped declaring — including one metered price.** A tier
leaves and its base price retires; a `usage` feature leaves a tier that stays and only that metered
price retires. Both are the same question asked of the same set, because `declaredLookupKeys` builds
one set from the base keys and the metered ones together.

**4. Archiving is idempotent and never deletes.** `active: false` on a Stripe price and `is_archived`
on a Polar product keep the object and everything that references it: an invoice line, a subscription,
a meter event. A second sweep finds nothing to do because the filter is `active`, not `exists`.

**5. The sweep never archives a price the catalog declares, and never touches another stage's.** The
declared set is the guard; the prefix is the scope. Both are checks a caller cannot skip by passing the
wrong list, because the function derives them rather than trusting an argument.

## Slices

### 1 — the decision (this one)

`lookupKeyPrefixOf`, `declaredLookupKeys` and `retiredPrices` in `paykit-stripe`, with tests that pin
the five refusals: another stage's price, another library's price, an already-archived price, a price
the catalog still declares, and `prod` against `production`.

The Polar half is the same shape over `name` and `is_archived`, and lands with its live test rather
than before it: guessing a vendor's field names from a mirror is how a sweep archives the wrong object.

### 2 — the write

A `RetiredPrices` resource that lists, calls `retiredPrices`, and deactivates the result. Every price
it touches is one nobody is selling, so the write is not reversible by a rollback — re-declaring the
tier creates a *new* price under the same lookup key, and the archived one stays archived. That is the
right shape, and it is why the sweep is a separate resource a deploy opts into rather than a step
`StripePrices` performs on its own.

The live test is the authority here, as with every other vendor write: a price created by the resource,
a tier removed from the catalog, a second deploy, and an assertion through the Stripe SDK that the
price is inactive and still retrievable.
