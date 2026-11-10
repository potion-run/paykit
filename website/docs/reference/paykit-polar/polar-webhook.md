---
title: "polarWebhook"
description: "Verify and translate one Polar webhook into paykit's provider-neutral event."
---

> **Source:** [`packages/paykit-polar/src/Webhooks.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-polar/src/Webhooks.ts#L168)
> **Kind:** Primitive

Verify and translate one Polar webhook into paykit's provider-neutral event.

`polarWebhook(props)` returns the function a `/webhooks/polar` route calls:
it checks the Standard Webhooks signature, decodes the payload, and answers
the `WebhookEvent` `handleWebhook` already knows how to apply — or `none`
for a Polar event paykit does not model, which the route answers 200 and
ignores.

The `webhook-id` header is the event id, so it becomes the command id: a
redelivery replays rather than activating, charging or cancelling twice.

## Handling a Polar webhook

```typescript
const webhook = polarWebhook({
  secret: yield* Config.redacted("POLAR_WEBHOOK_SECRET"),
  tiers,
});

return Effect.gen(function* () {
  const event = yield* webhook({ headers: Object.fromEntries(request.headers), body });
  if (Option.isSome(event)) yield* handleWebhook(event.value);
  return new Response(null, { status: 202 });
});
```
