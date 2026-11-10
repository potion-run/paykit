---
title: "Subscribe"
description: "The one door to a purchase."
---

> **Source:** [`packages/paykit/src/Billing/Subscribe.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/Subscribe.binding.ts#L70)
> **Kind:** Binding · **Product:** Subscription · **Provides:** `Paykit.Subscribe`

The one door to a purchase. A free tier activates immediately and waits for
the `Entitlements` view, so a `Check` straight after sees it. A priced tier
opens the provider's purchase path — a hosted checkout when it has one, a
send-invoice when it only has that — and activates when the provider's
`payment_succeeded` or `checkout_completed` webhook arrives.

An operation, not a command: the Api serves the command, but the purchase path
is the provider's, and only the deployment that holds the provider can walk
it.

## Selling a tier

```typescript
const subscribe = yield* Paykit.Subscribe(account);
const purchase = yield* subscribe({ tier: "pro" });
if ("url" in purchase) return Response.redirect(purchase.url);
```
