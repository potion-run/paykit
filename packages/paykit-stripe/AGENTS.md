# @potion.run/paykit-stripe

Stripe for paykit: one call that returns a `Payments` provider, the webhook that moves a
standing, and the three Stripe calls they need. Over `@distilled.cloud/stripe`.

Resource-provider patterns (lifecycle, Reconciler doctrine, ownership, tests) live in the root
[AGENTS.md](../../AGENTS.md#resource-providers).

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

// The deploy creates the prices the catalog states and hands back the keys.
const sold = yield* StripePrices("Prices", {
  tiers: {
    pro: {
      price: proPrice,
      usage: { messages: { amount: 2, currency: "usd" } },
    },
  },
});

const stripe = Stripe({
  secretKey: yield* Config.redacted("STRIPE_SECRET_KEY"),
  origin: "https://app.example.com",
  tiers: {
    pro: {
      price: proPrice,
      lookupKey: sold.prices.pro,
      usage: {
        messages: { unitPrice: { amount: 2, currency: "usd" }, lookupKey: sold.usage.pro.messages },
      },
    },
  },
  meters: sold.meters,
});
```

| Export | What it is |
| --- | --- |
| `StripeBilling(id, props)` | provisioning and the provider in one call; returns the `MoneyProvider` plus the keys it created |
| `Stripe(props)` | the whole thing: a `Provider<"processor">` for `Paykit.BillingStack` |
| `StripeTier` | where a tier lives in Stripe, and the price the catalog states |
| `StripeProps` | key, origin and the tier mapping |
| `StripeClient` | the Stripe calls, as an interface a test stands in for |
| `distilledStripeClient` | `@distilled.cloud/stripe` behind those calls |
| `stripeWebhook(props)` | verifies and translates a Stripe webhook into paykit's `WebhookEvent` |
| `StripeProps.webhookSecret` | given it, the provider carries `webhook.decode` itself |
| `StripePrices(id, { tiers })` | creates the products, base prices, meters and metered prices the catalog states, and returns `{ prices, usage, meters }` |
| `priceDeclarations(tiers)` | the pure mapping: resource ids, lookup keys, amounts, intervals |
| `lookupKeyOf(stage, tier)` | `paykit:<stage>:<tier>`, the only identity that survives a restore |

`Stripe()` builds the distilled client from `secretKey` when no `client` is given, so a deployment
wires nothing. It returns what the catalog needs and nothing else: `kind`, `capabilities`,
`payments` and `prices`, so `BillingStack` can check the mapping against the catalog at deploy time.

`StripeBilling(id, { secretKey, origin, tiers })` is the common deployment: it yields
`StripePrices` and `Stripe` with the same tier map, so the user does not repeat the lookup keys.
`StripePrices` and `Stripe` stay for a deployment that provisions and configures separately.

`stripeWebhook()` is the other half of a deployment: the money plane is Stripe's, but the standing
only moves when paykit applies the provider's event. The signature check is
`@distilled.cloud/stripe`'s own `constructEvent`; this package decodes the payload and answers the
`WebhookEvent` `handleWebhook` already knows how to apply — `none` for a Stripe event paykit does
not model, which the route answers 200 and ignores. The Stripe event id becomes the command id, so
a redelivery replays instead of charging twice.

## The deploy provisions the prices

`StripePrices` yields one `@alchemy.run/stripe` `Product` and base `Price` per priced tier — the
vendor package's own resources, not a second implementation — plus a `BillingMeter` and a metered
`Price` for every `usage` feature. It returns `SoldPrices`: the base lookup key per tier, the metered
lookup key per tier and feature, and the meter event name per feature. `Stripe({ meters })` carries
the meter map to the runtime so the close can report usage. Three rules come with it, from
[ADR 0003](../paykit/docs/adr/0003-the-deploy-provisions-the-vendor.md):

- **A price is never deleted.** A tier that leaves the catalog is archived, because invoices
  reference it. A changed amount creates a new price, moves the lookup key onto it
  (`transfer_lookup_key`) and archives the old one, because Stripe prices are immutable and a live
  subscription must not change what it is charged.
- **The lookup key is the identity, the id is a cache.** `paykit:<stage>:<tier>` is what a restored
  state reconciles to; a price id is an output of one run. The stage is in the key because every
  stage that shares a key pair shares the Stripe account, and `transfer_lookup_key` would otherwise
  let a preview price take the key from production's.
- **The catalog stays provider-free.** `StripePrices` takes prices and returns keys. Nothing about
  Stripe reaches the catalog, and a stack that runs two providers declares both from the same
  prices. A tier entry can state `kind: "one_off"` so its price is one-time; the checkout then uses
  Stripe's `mode: "payment"` instead of starting a subscription.

`Stripe({ tiers })` accepts either handle: a `priceId` pins one price object, a `lookupKey` resolves
to whichever price currently answers for the tier (through `resolvePrice`, which the distilled
client implements with `GetPrices`). With a key, changing a price in the catalog needs no config
change. The checkout carries the base price and every metered price as line items on one
subscription, and `StripeProps.meters` is what lets `reportUsage` send one meter event per feature
with the closing period as its identifier.

## Rules

- **The catalog never carries a Stripe id.** A tier maps to a `priceId` here, in provider config.
  `Stack` refuses a mapping whose amount, currency or interval disagrees with the catalog.
- **A capability is what the client implements.** `checkout` and `portal` are always there;
  `invoice` and `refund` are declared only when the client carries them, and asking for an absent
  one fails with `ProviderCapabilityMissing`. A stub that returns success would be a silent
  degradation.
- **The checkout carries the tier.** The session is created with `client_reference_id` and
  `metadata.tier`, so the webhook reads what was bought instead of grepping a line item. An invoice
  or a subscription has no such metadata, so its tier comes from the price the buyer paid for — and
  a price no tier maps drops the tier rather than inventing one or refusing the endpoint.
- **A vendor failure is `PaymentDeclined`**, never a defect. The model must be able to record a
  failed charge.
- **Vendor types are the vendor's.** The distilled SDK's types are used directly, so a field
  renamed upstream is a compile error here, not a silently dropped argument.
- **`@potion.run/paykit` is a peer**, so a user who installs this gets one paykit, not two.
