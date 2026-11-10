# Stripe example

A Worker that sells one paykit tier through Stripe. The deploy provisions the
product, its price, its meter and its metered price with `StripeBilling`, then
hands the lookup keys and meter name to the Worker through its environment. The
runtime builds `Stripe({ tiers, meters, webhookSecret })` from those keys, so
the catalog and the vendor mapping are stated once.

```sh
STRIPE_API_KEY=sk_test_… \
STRIPE_WEBHOOK_SECRET=whsec_… \
pnpm --filter @potion.run/example-stripe deploy
```

`Stripe.providers()` reconciles the vendor objects with `STRIPE_API_KEY`; the
runtime provider uses the same key for checkout and the webhook secret to
verify deliveries. The stack prints the lookup keys and meter name it created,
and the Worker receives the same outputs as bindings:

| File | What it declares |
| --- | --- |
| `src/catalog.ts` | Two tiers and the prices `StripeBilling` copies onto the price and meter. |
| `alchemy.run.ts` | `StripeBilling`, `BillingStack`, and the Worker with the lookup keys in its env. |
| `src/Billing.ts` | The runtime `Stripe` provider, its world, and the two money routes. |
| `src/StripeWorker.ts` | `GET /checkout?tier=pro` and `POST /webhooks/stripe`, served by `Paykit.handler`, plus the `/` page this example owns. |
| `test/example.test.ts` | The same routes with a fake Stripe client and a signed delivery. |

```sh
pnpm --filter @potion.run/example-stripe test   # no Stripe account needed
```

The test uses a fake client, so it proves the loop without a key. A deployment
needs a Stripe test key and a webhook endpoint secret. The account header is the
example's stand-in for a session; a real deployment resolves its own actor, as
`examples/auth` does.

The difference from `examples/polar`: Stripe names a price by a lookup key
`StripeBilling` creates, so the runtime resolves the key to whichever price
answers for the tier now. A catalog price change replaces the price and moves
the key, and the Worker needs no redeploy for the new amount.
