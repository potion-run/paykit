---
title: "SetupPayment"
description: "Add a payment method without a purchase."
---

> **Source:** [`packages/paykit/src/Billing/SetupPayment.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/SetupPayment.binding.ts#L34)
> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.SetupPayment`

Add a payment method without a purchase. The provider hosts the page and the
deployment redirects there: a free plan that wants a card on file, a trial
that asks for one up front, or a dunning recovery that replaces an expired
card. It never charges, never opens a period and writes no paykit command —
the URL is the whole answer, exactly like `Portal`.

The page belongs to the provider the account already pays through, so the
standing picks it and only that provider's layer is provided for the call. A
provider with no hosted method page is `ProviderCapabilityMissing`, never a
fake URL.

## Adding a card before an upgrade

```typescript
const setupPayment = yield* Paykit.SetupPayment(account);
const { url } = yield* setupPayment();
return Response.redirect(url);
```
