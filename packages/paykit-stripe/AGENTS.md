# @potion.run/paykit-stripe

Stripe for paykit: one call that returns a `Payments` provider, the webhook that moves a
standing, and the three Stripe calls they need. Over `@distilled.cloud/stripe`.

**This is a paykit package, not a general Alchemy provider.** It imports `@potion.run/paykit`,
because its whole job is to be the shortest path from a catalog to a working Stripe processor.
That is a deliberate maintenance choice: a general provider would need its own users, docs,
release train and a stable general-purpose surface, and we would carry all of it to serve one
adapter. The shape is Alchemy's — resources and bindings over a distilled SDK — but the surface is
paykit's.

If someone later needs Stripe without paykit, `@alchemy.run/stripe` already exists and is theirs to
use. Do not grow this one into it.

## Surface

```ts
import { Stripe } from "@potion.run/paykit-stripe";
import { Paykit } from "@potion.run/paykit";

const stripe = Stripe({
  secretKey: yield* Config.redacted("STRIPE_SECRET_KEY"),
  origin: "https://app.example.com",
  tiers: { pro: { price: proPrice, priceId: "price_123" } },
});
```

| Export | What it is |
| --- | --- |
| `Stripe(props)` | the whole thing: a `Provider<"processor">` for `Paykit.Stack` |
| `StripeTier` | where a tier lives in Stripe, and the price the catalog states |
| `StripeProps` | key, origin and the tier mapping |
| `StripeClient` | the Stripe calls, as an interface a test stands in for |
| `distilledStripeClient` | `@distilled.cloud/stripe` behind those calls |
| `stripeWebhook(props)` | verifies and translates a Stripe webhook into paykit's `WebhookEvent` |
| `StripeSignatureInvalid` | the request did not come from Stripe, or did not come recently |

`Stripe()` builds the distilled client from `secretKey` when no `client` is given, so a deployment
wires nothing. It returns what the catalog needs and nothing else: `kind`, `capabilities`,
`payments` and `prices`, so `Stack` can check the mapping against the catalog at deploy time.

`stripeWebhook()` is the other half of a deployment: the money plane is Stripe's, but the standing
only moves when paykit applies the provider's event. The signature check is
`@distilled.cloud/stripe`'s own `constructEvent`; this package decodes the payload and answers the
`WebhookEvent` `handleWebhook` already knows how to apply — `none` for a Stripe event paykit does
not model, which the route answers 200 and ignores. The Stripe event id becomes the command id, so
a redelivery replays instead of charging twice.

## Rules

- **The catalog never carries a Stripe id.** A tier maps to a `priceId` here, in provider config.
  `Stack` refuses a mapping whose amount, currency or interval disagrees with the catalog.
- **A capability is what the client implements.** `checkout` and `portal` are always there;
  `invoice`, `refund` and `syncTier` are declared only when the client carries them, and asking for
  an absent one fails with `ProviderCapabilityMissing`. A stub that returns success would be a
  silent degradation.
- **The checkout carries the tier.** The session is created with `client_reference_id` and
  `metadata.tier`, so the webhook reads what was bought instead of grepping a line item. An invoice
  or a subscription has no such metadata, so its tier comes from the price the buyer paid for — and
  a price no tier maps drops the tier rather than inventing one or refusing the endpoint.
- **A vendor failure is `PaymentDeclined`**, never a defect. The model must be able to record a
  failed charge.
- **Vendor types are the vendor's.** The distilled SDK's types are used directly, so a field
  renamed upstream is a compile error here, not a silently dropped argument.
- **`@potion.run/paykit` is a peer**, so a user who installs this gets one paykit, not two.
