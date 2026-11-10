---
title: "Webhook"
description: "The webhook edge as a binding: the model's services resolved once, an event applied per delivery."
---

> **Source:** [`packages/paykit/src/Billing/Webhook.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/Webhook.binding.ts#L45)
> **Kind:** Binding · **Product:** Payments · **Provides:** `Paykit.Webhook`

The webhook edge as a binding: the model's services resolved once, an event
applied per delivery. The provider's event id is the command id, so a
redelivery is a replay rather than a second charge, and a one-off pack
purchase adds credits instead of creating a standing.

The bind takes nothing — the deployment is the scope — and the request is the
*decoded* event. This is the one binding that does **not** wait for a read
model afterwards: it has no receipt of its own to wait on, and a provider
needs an answer, not a snapshot. Whoever reads next reads the view.

The bind takes nothing, so a delivery for any account can be applied. Decoding is the provider's: `Stripe()` and `Polar()` return a
`webhook.decode` that verifies the signature and translates the payload, and a
`none` from it is a 202 that records nothing.

## Applying a delivery

```typescript
const webhook = yield* Paykit.Webhook();

const decoded = yield* provider.webhook.decode(request);
if (Option.isNone(decoded)) return new Response(null, { status: 202 });
const action = yield* webhook(decoded.value);
return Response.json({ action }, { status: 202 });
```
