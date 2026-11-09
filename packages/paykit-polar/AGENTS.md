# @potion.run/paykit-polar

Polar for paykit: one call that returns a `Payments` provider, the products its tiers are sold
as, and the Polar-shaped pieces it needs to do that. Over `@distilled.cloud/polar`.

Resource-provider patterns (lifecycle, Reconciler doctrine, ownership, tests) live in the root
[AGENTS.md](../../AGENTS.md#resource-providers).

**This is a paykit package, not a general Alchemy provider.** It imports `@potion.run/paykit`,
because its whole job is to be the shortest path from a catalog to a working Polar merchant of
record. That is a deliberate maintenance choice: a general provider would need its own users, docs,
release train and a stable general-purpose surface, and we would carry all of it to serve one
adapter.

If someone later needs Polar without paykit, that is a *different* package with a different name,
written for those users. Do not grow this one into it.

## Surface

```ts
import { Polar } from "@potion.run/paykit-polar";
import { Paykit } from "@potion.run/paykit";

const sold = yield* PolarPrices("Prices", {
  tiers: {
    pro: {
      price: proPrice,
      usage: { messages: { amount: 2, currency: "usd" } },
    },
  },
});

const polar = Polar({
  accessToken: Config.redacted("POLAR_ACCESS_TOKEN"),
  server: "production",           // or "sandbox"
  origin: "https://app.example.com",
  tiers: {
    pro: {
      price: proPrice,
      productId: sold.products.pro,
      usage: { messages: { amount: 2, currency: "usd" } },
    },
  },
  meters: sold.meters,
});
```

| Export | What it is |
| --- | --- |
| `PolarBilling(id, props)` | provisioning and the provider in one call; returns the `MoneyProvider` plus the products it created |
| `Polar(props)` | the whole thing: a `Provider<"merchant_of_record">` for `Paykit.BillingStack` |
| `PolarTier` | where a tier lives in Polar, and the price the catalog states |
| `PolarProps` | token, server, origin and the tier mapping |
| `PolarClient` | the Polar calls, as an interface a test stands in for |
| `PolarClient.createSetupSession` | the customer session where a customer adds a method, without a purchase |
| `distilledPolarClient` | `@distilled.cloud/polar` behind those three calls |
| `PolarPrices(id, { tiers })` | creates the products, meters and metered prices the catalog states, and returns `{ products, meters }` |
| `soldTiers(tiers, sold)` | the pure join from catalog prices and created products to the `Polar({ tiers })` map |
| `priceDeclarations(tiers, stage)` | the pure mapping: names, resource ids and the prices |
| `productNameOf(stage, tier)` | `paykit:<stage>:<tier>`, the name that carries the stage |
| `RetiredProducts(id, { tiers })` | archives the products a stage still sells that its catalog no longer declares, and returns `{ archived }` |
| `retiredProducts(declarations, found, stage)` | the pure decision the sweep writes: ours, still sellable, undeclared |
| `productNamePrefixOf(stage)` | `paykit:<stage>:`, the prefix a stage's sweep is scoped to |
| `Product` | the `Polar.Product` resource a stack reconciles |
| `Meter` | the `Polar.Meter` resource a metered price counts through |
| `polarProviders({ accessToken, server })` | the provider layer a stack mounts so `PolarPrices` can run |
| `polarWebhook(props)` | verifies and translates a Polar webhook into paykit's `WebhookEvent` |
| `PolarProps.webhookSecret` | given it, the provider carries `webhook.decode` itself |
| `PolarWebhookError` | a delivery did not come from Polar, or did not come recently |

`Polar()` builds the distilled client from `accessToken` + `server` when no
`client` is given, so a deployment wires nothing: `server: "sandbox"` points at
sandbox, and a production token cannot be sent to it by accident.

`PolarBilling(id, { accessToken, origin, tiers })` is the common deployment: it
yields `PolarPrices` and `Polar`, with the tier map stated once as catalog prices.
A Polar product id is an `Output<string>` because Polar mints it, so the provider
keeps the handle and resolves it when a checkout or a webhook needs the id.
`PolarPrices` and `Polar` stay for a deployment that provisions and configures
separately, and `Polar({ tiers })` with written product ids stays the runtime
path when the ids come from the Worker's environment.

`Polar()` returns what the catalog needs and nothing else: `kind`, `capabilities`, `payments` and
`prices`, so `Stack` can check the mapping against the catalog at deploy time.

`polarWebhook()` is the other half of a deployment: the money plane is Polar's, but the standing
only moves when paykit applies the provider's event. It checks the Standard Webhooks signature,
decodes the payload and answers the `WebhookEvent` `handleWebhook` already knows how to apply —
`none` for a Polar event paykit does not model, which the route answers 200 and ignores. The
`webhook-id` header becomes the command id, so a redelivery replays instead of charging twice.

## The deploy provisions the products

`PolarPrices` yields one `Polar.Product` per priced tier and one `Polar.Meter` per billable feature,
then returns `SoldPrices`: the product id per tier and the meter event name per feature. Mount
`polarProviders({ accessToken, server })` beside the other providers so the stack can reconcile
them. Each product id is an Alchemy `Output<string>`: `PolarBilling` keeps it as a deferred handle,
and a deployment that provisions separately hands it to the Worker's environment and builds
`Polar({ tiers })` there with the resolved id, plus `meters` for the close. A product carries its
fixed price and every metered price; a package is a `metered_unit` price with its per-unit
decimal, a ladder is a `metered_tiers` price, and a changed metered price is a new product
generation. Three
rules come with it, from [ADR 0003](../paykit/docs/adr/0003-the-deploy-provisions-the-vendor.md):

- **A product is never deleted.** A tier that leaves the catalog is retained: `RemovalPolicy.retain`
  skips the provider's delete, so the product stays in Polar and only the state row goes away.
  Retaining does not stop it being bought, which is what `RetiredProducts` closes: a sweep that
  archives what the catalog stopped declaring, keyed by the stage-qualified name and
  `metadata.paykit_tier`, with `is_archived` so the orders and subscriptions that reference it are
  untouched ([ADR 0010](../paykit/docs/adr/0010-a-price-that-leaves-the-catalog-is-archived-not-deleted.md)).
- **The tier is the identity, in Polar's own fields.** `metadata.paykit_tier = "<tier>"` plus the
  stage-qualified name `paykit:<stage>:<tier>`. A state-lost deploy finds the product by that pair
  instead of creating a second one, and a price change is a new generation of the same identity.
- **The catalog stays provider-free.** `PolarPrices` takes prices and returns products and meters.
  Nothing about Polar reaches the catalog, and a stack that runs two providers declares both from the
  same prices. A tier entry can state `kind: "one_off"` so its product is one-time; the checkout then
  charges once instead of starting a subscription.

Polar embeds prices in the product, where Stripe models a price as its own object. So a price change
replaces the product (a new id, the old one kept), and the difference stops inside this package:
`paykit`'s `PolarTier` keeps its `{ price, productId }` shape.

## Rules

- **The catalog never carries a Polar id.** A tier maps to a `productId` here, in provider config.
  `Stack` refuses a mapping whose amount, currency or interval disagrees with the catalog.
- **A missing capability is `ProviderCapabilityMissing`.** `Polar()` sells through checkout,
  refunds on request and opens the customer portal, so it declares `checkout`, `refund` and
  `portal`, `invoice` when `invoiceProductId` is configured, and `usage` when `meters` is. It
  declares no `charge`: a merchant of record collects through its own invoice, and `ordersFinalize`
  already attempts the saved method, so the auto top-up invoices here and takes the invoice record
  ([ADR 0018](../paykit/docs/adr/0018-a-saved-method-is-a-capability.md)). A binding that asks for an
  absent op fails with a typed error rather than silently doing nothing.
- **A vendor failure is `PaymentDeclined`**, never a defect. The model must be able to record a
  failed charge. The one defect the webhook path has is a runtime without WebCrypto: nothing can
  be verified there, and that is a deployment to fix, not a request to refuse.
- **The webhook is translated, not trusted.** Signature first (Standard Webhooks, both Polar key
  derivations), then the payload. A missing external customer id is `WebhookInvalid` naming the
  field. A product no tier maps never fails the endpoint and never invents a tier: the event keeps
  the account and drops the tier, so an unrelated one-off product is not a reason to retry.
- **Typed errors come from `@distilled.cloud/polar`.** Matching a status code or a bare `_tag`
  string means the patch is missing upstream — fix it there, not with a cast here.
- **`@potion.run/paykit` is a peer**, so a user who installs this gets one paykit, not two.
