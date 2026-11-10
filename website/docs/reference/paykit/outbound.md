---
title: "Outbound"
description: "The outbound edge as a port: the endpoints to notify and the transport that sends a signed request."
---

> **Source:** [`packages/paykit/src/Outbound.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Outbound.ts#L40)
> **Kind:** Primitive

The outbound edge as a port: the endpoints to notify and the transport that
sends a signed request. Provide it beside the model; without it the policy
is a no-op, so a deployment that does not want push pays nothing for it.

The app owns HTTP (a Worker, a queue, a test): paykit owns the event, the
signature and the idempotency key. That is the same split as `Payments`: the
model never talks to a vendor, and a port never decides a standing.

## Sending every event to one endpoint

```ts
const outbound = Layer.succeed(Outbound, {
  endpoints: [{ url: "https://app.example/hooks/paykit", secret: Redacted.make(secret) }],
  deliver: ({ endpoint, body, headers }) =>
    Effect.gen(function* () {
      const response = yield* HttpClient.post(endpoint.url, { body, headers });
      if (response.status >= 300) {
        return yield* new OutboundDeliveryError({
          endpoint: endpoint.url,
          reason: `HTTP ${response.status}`,
        });
      }
    }),
});
```
