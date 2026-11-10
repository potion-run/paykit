---
title: "stripeWebhook"
description: "Verify and translate one Stripe webhook into paykit's provider-neutral event."
---

> **Source:** [`packages/paykit-stripe/src/Webhooks.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-stripe/src/Webhooks.ts#L80)
> **Kind:** Primitive

Verify and translate one Stripe webhook into paykit's provider-neutral event.

`stripeWebhook(props)` returns the function a `/webhooks/stripe` route calls:
the signature check is `@distilled.cloud/stripe`'s own `constructEvent`, then
the payload is decoded and answered as the `WebhookEvent` `handleWebhook`
already knows how to apply — or `none` for an event paykit does not model,
which the route answers 200 and ignores.

The Stripe event id is the command id, so a redelivery replays rather than
activating, charging or cancelling twice.

The tier comes from the price the buyer actually paid for — read in the
mapping, never invented: a price no tier maps keeps the account and drops the
tier rather than refusing the endpoint.

## Handling a Stripe webhook

```typescript
const webhook = stripeWebhook({
  secret: yield* Config.redacted("STRIPE_WEBHOOK_SECRET"),
  tiers,
});

return Effect.gen(function* () {
  const event = yield* webhook({ headers: Object.fromEntries(request.headers), body });
  if (Option.isSome(event)) yield* handleWebhook(event.value);
  return new Response(null, { status: 202 });
});
```
