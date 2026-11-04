# @potion.run/paykit-polar

Polar for paykit: one call that returns a `Payments` provider, and the Polar-shaped pieces it
needs to do that. Over `@distilled.cloud/polar`.

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

const polar = Polar({
  accessToken: Config.redacted("POLAR_ACCESS_TOKEN"),
  server: "production",           // or "sandbox"
  origin: "https://app.example.com",
  tiers: { pro: { price: proPrice, productId: "prod_123" } },
});
```

| Export | What it is |
| --- | --- |
| `Polar(props)` | the whole thing: a `Provider<"merchant_of_record">` for `Paykit.Stack` |
| `PolarTier` | where a tier lives in Polar, and the price the catalog states |
| `PolarProps` | token, server, origin and the tier mapping |
| `PolarClient` | the three Polar calls, as an interface a test stands in for |
| `distilledPolarClient` | `@distilled.cloud/polar` behind those three calls |
| `polarWebhook(props)` | verifies and translates a Polar webhook into paykit's `WebhookEvent` |
| `PolarProps.webhookSecret` | given it, the provider carries `webhook.decode` itself |
| `PolarSignatureInvalid` | the request did not come from Polar, or did not come recently |

`Polar()` builds the distilled client from `accessToken` + `server` when no
`client` is given, so a deployment wires nothing: `server: "sandbox"` points at
sandbox, and a production token cannot be sent to it by accident.

`Polar()` returns what the catalog needs and nothing else: `kind`, `capabilities`, `payments` and
`prices`, so `Stack` can check the mapping against the catalog at deploy time.

`polarWebhook()` is the other half of a deployment: the money plane is Polar's, but the standing
only moves when paykit applies the provider's event. It checks the Standard Webhooks signature,
decodes the payload and answers the `WebhookEvent` `handleWebhook` already knows how to apply —
`none` for a Polar event paykit does not model, which the route answers 200 and ignores. The
`webhook-id` header becomes the command id, so a redelivery replays instead of charging twice.

## Rules

- **The catalog never carries a Polar id.** A tier maps to a `productId` here, in provider config.
  `Stack` refuses a mapping whose amount, currency or interval disagrees with the catalog.
- **A missing capability is `ProviderCapabilityMissing`.** `Polar()` sells through checkout,
  refunds on request and opens the customer portal, so it declares `checkout`, `refund` and
  `portal`. `createInvoice` is never declared — Polar's purchase path is checkout — and `syncTier`
  is declared only when the supplied `client` implements it, because the distilled client exposes
  no benefit sync. A binding that asks for an absent op fails with a typed error rather than
  silently doing nothing.
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
