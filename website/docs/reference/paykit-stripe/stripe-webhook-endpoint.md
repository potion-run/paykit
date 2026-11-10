---
title: "stripeWebhookEndpoint"
description: "The webhook endpoint a deployment serves Stripe's deliveries on."
---

> **Source:** [`packages/paykit-stripe/src/WebhookEndpoint.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-stripe/src/WebhookEndpoint.ts#L44)
> **Kind:** Primitive · **Product:** Stripe

The webhook endpoint a deployment serves Stripe's deliveries on.

`StripeBilling` creates it when the deploy has no `webhookSecret`: the URL is
the app's origin plus `/webhooks/stripe`, the events are exactly the ones
`stripeWebhook` decodes, and the secret Stripe mints at create is what the
Worker verifies with. Supplying `webhookSecret` keeps the endpoint
hand-managed and creates nothing here.

The vendor object is `@alchemy.run/stripe`'s own `WebhookEndpoint`, so the
ownership metadata, adoption and drift are that package's job, not a second
implementation's. Removal is the default `destroy`: an endpoint is
configuration, not financial history, and a stack destroy has already removed
the Worker that would answer its deliveries.

## Receiving Stripe's events

```typescript
const endpoint = yield* stripeWebhookEndpoint("Deliveries", {
  url: "https://app.example.com/webhooks/stripe",
});
// The Worker verifies deliveries with the secret minted at create; the
// billing result carries it into the environment as an Output.
```
