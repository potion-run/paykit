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

`Polar()` builds the distilled client from `accessToken` + `server` when no
`client` is given, so a deployment wires nothing: `server: "sandbox"` points at
sandbox, and a production token cannot be sent to it by accident.

`Polar()` returns what the catalog needs and nothing else: `kind`, `capabilities`, `payments` and
`prices`, so `Stack` can check the mapping against the catalog at deploy time.

## Rules

- **The catalog never carries a Polar id.** A tier maps to a `productId` here, in provider config.
  `Stack` refuses a mapping whose amount, currency or interval disagrees with the catalog.
- **A missing capability is `ProviderCapabilityMissing`.** Polar ships no customer portal through
  this adapter yet, so it declares no `portal`; a binding that needs one fails with a typed error
  rather than silently doing nothing.
- **A vendor failure is `PaymentDeclined`**, never a defect. The model must be able to record a
  failed charge.
- **Typed errors come from `@distilled.cloud/polar`.** Matching a status code or a bare `_tag`
  string means the patch is missing upstream — fix it there, not with a cast here.
- **`@potion.run/paykit` is a peer**, so a user who installs this gets one paykit, not two.
