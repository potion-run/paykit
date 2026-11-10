---
title: "PolarBilling"
description: "Polar provisioning and the Polar provider in one call."
---

> **Source:** [`packages/paykit-polar/src/PolarBilling.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-polar/src/PolarBilling.ts#L63)
> **Kind:** Primitive · **Product:** Polar

Polar provisioning and the Polar provider in one call.

`PolarPrices` creates the products, meters and prices the catalog states;
`Polar(props)` turns those products into the provider the billing stack
validates. A deployment always needs both, and the tier map is the same in
both, so this joins them once instead of making the user repeat it.

When `webhookSecret` is omitted, the deploy also reconciles the
`WebhookEndpoint` at `origin + webhookPath` and carries the secret Polar
mints at create into the Worker's environment. The secret stays an `Output`
because the stack program declares it before Polar has minted it: the
returned provider's webhook decoder reads the attribute when a delivery is
verified, and a Worker builds its own `Polar` from the environment, where the
secret is a plain `Redacted`. Supplying `webhookSecret` keeps the endpoint
managed by hand, exactly as before, and creates nothing.

A Polar product id is minted by Polar, so the join cannot be a plain string
at declaration time: the provider carries the `Output`s `PolarPrices`
returned and resolves one at the moment a checkout or a webhook needs it.

The two primitives stay exported: use `PolarPrices` when the provider is
configured elsewhere, and `Polar` when the product ids are written by hand.

## Selling a catalog through Polar

```typescript
const polar = yield* PolarBilling("Polar", {
  accessToken: yield* Config.redacted("POLAR_ACCESS_TOKEN"),
  origin: "https://app.example.com",
  tiers: {
    pro: {
      price: proPrice,
      usage: { messages: { amount: 2, currency: "usd" } },
    },
  },
});

yield* Paykit.BillingStack("Billing", { catalog, providers: [polar] });
// The Worker receives `polar.webhookEndpoint.secret`, minted by the endpoint
// this call created at https://app.example.com/webhooks/polar.
```
