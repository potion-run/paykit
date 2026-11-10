---
title: "WebhookEndpoint"
description: "Exports `WebhookEndpoint`, `polarWebhookEndpoint`."
---

> **Source:** [`packages/paykit-polar/src/WebhookEndpoint.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-polar/src/WebhookEndpoint.ts#L120)

## WebhookEndpoint

> **Kind:** Resource · **Product:** Webhook

A Polar webhook endpoint, the destination a standing activation arrives at.

`PolarBilling` creates it when the deploy has no `webhookSecret`: the URL is
the app's origin plus `/webhooks/polar`, the events are exactly the ones
`polarWebhook` decodes, and the secret Polar mints at create is handed to
the Worker. Supplying `webhookSecret` keeps the endpoint hand-managed and
creates nothing here.

The identity is the name, `paykit:<stack>:<stage>:<segment>`, because a
Polar webhook endpoint has no metadata field. The scope prefix is what makes
a state-lost deploy adopt the endpoint it already made instead of creating a
second one, and `list` is scoped by the same prefix.

Everything except the secret changes in place: `url`, `events`, `format`,
`enabled` and the name segment are all fields of
`WebhooksUpdateWebhookEndpointRequest`, so a change never replaces the
endpoint and never rotates its secret. The secret is not recoverable through
the API after create, which is why it is preserved from state.

Removal is `destroy`. An endpoint is configuration, not financial history:
the deliveries it forwards are transient and a stack destroy has already
removed the Worker that would answer them. Leaving it behind would leave
Polar posting a retired URL. A product is the opposite and is retained, per
ADR 0003.

### Pointing Polar at a deployment

```typescript
const endpoint = yield* WebhookEndpoint("Webhook", {
  url: Output.interpolate`${api.url}/webhooks/polar`,
});
// The Worker verifies deliveries with the secret minted at create; pass the
// attribute into its environment, where the deploy resolves it.
const secret = endpoint.secret;
```

## polarWebhookEndpoint

> **Kind:** Primitive · **Product:** Polar

The webhook endpoint a deployment serves Polar's deliveries on.

It defaults to the events `polarWebhook` decodes and to the name the stack
and stage derive, so the common deployment states a URL and nothing else.

### Receiving Polar's events

```typescript
const endpoint = yield* polarWebhookEndpoint(`Webhook`, {
  url: "https://app.example.com/webhooks/polar",
});
// The Worker verifies deliveries with the secret minted at create; the
// billing result carries it into the environment as an Output.
```
