# 0051 — The webhook endpoint is a resource the deploy owns

- **Status:** Accepted
- **Date:** 2026-11-10
- **Follows:** [0001](./0001-catalog-states-the-pricing-model.md), [0003](./0003-the-deploy-provisions-the-vendor.md)

## Context

ADR 0003 says the products, prices and webhook endpoint a provider needs come from the catalog. The
first two are resources: `StripePrices` and `PolarPrices` reconcile them, `BillingStack` validates
their mapping against the catalog, and a destroyed stack retains them because a price is financial
history.

The endpoint was the exception. A deployment created it in the provider's dashboard and copied its
signing secret into configuration (`STRIPE_WEBHOOK_SECRET`, `POLAR_WEBHOOK_SECRET`). Three
consequences follow, and all three are the class of problem this library exists to remove:

- A fresh environment cannot receive a single delivery without a human. Products and prices converge;
  the endpoint does not.
- The secret has no diff. Rotating it is an out-of-band edit, so two environments can disagree about
  which deliveries are verifiable and neither is wrong.
- The endpoint's event list is a second spelling of what the decoder accepts. Nothing checks that the
  vendor sends the events paykit actually handles.

Alchemy already models the Stripe half: `Stripe.WebhookEndpoint` is a resource whose `secret` is a
`Redacted` attribute returned at creation and preserved in state, with list/read/reconcile/delete and
ownership metadata. Polar's API has the same object (`webhooksCreateWebhookEndpoint` and friends),
but Polar's Alchemy package does not exist, so its resource belongs in `paykit-polar`.

The endpoint is not a price. Destroying a stack must delete it, or a destroyed environment keeps
receiving deliveries at a URL that no longer serves the decoder. This is the one place where the
"retain financial history" rule does not apply.

## Decision

**1. Each provider package owns an endpoint resource.** `paykit-stripe` reuses
`Stripe.WebhookEndpoint` from `@alchemy.run/stripe`; `paykit-polar` adds `Polar.WebhookEndpoint`,
following the same lifecycle (observe → ensure → sync → delete) and the same ownership discipline.
A Stripe endpoint is branded with Alchemy's ownership metadata. Polar's endpoint has no metadata
field, so its name carries the scope: `paykit:<encoded stack>:<encoded stage>:webhook`; `read`
returns `Unowned` for a name that does not match, and `list` enumerates the prefix.

**2. `*Billing` converges the endpoint from the catalog's origin.** `StripeBilling` and
`PolarBilling` take an optional `webhookPath` (defaulting to `/webhooks/stripe` and
`/webhooks/polar`), create the endpoint at `` `${origin}${webhookPath}` `` when the caller did not
supply a `webhookSecret`, and carry the minted secret into the runtime provider. The endpoint is
returned as `webhookEndpoint: { resource, secret }`, so a deployment can inspect its id and install
the secret; the field is not named `webhook` because `MoneyProvider.webhook` is the decoder.

The secret stays an `Output` on the deploy side. A resource attribute does not exist while the stack
is declared, so the deploy-time provider holds the attribute and the decoder resolves it when a
delivery needs it; a Worker builds its provider from the environment and passes a plain `Redacted`.
Resolving the attribute early is not an option: it would require a runtime context the stack program
is not running under.

**3. The secret is an output, never configuration.** The billing result carries it into the Worker's
environment, exactly like a product id. A deployment that already owns an endpoint — a shared API,
a different host, a secret in a vault — passes `webhookSecret` and pays for no resource. That is an
escape hatch, not the default.

**4. The event list is the decoder's list.** `STRIPE_WEBHOOK_EVENTS` and `POLAR_WEBHOOK_EVENTS` are
exported beside the decoder, and the endpoint is created with exactly those events. A new decoded
event and its subscription land in the same change.

**5. Deleting the stack deletes the endpoint.** The resource's removal policy is the default
destroy, not `retain`: an endpoint that outlives its deployment is a delivery target that answers
with the wrong decoder or nothing at all.

## Consequences

- A deploy from an empty vendor account produces products, prices, meters, an endpoint and a secret,
  and the Worker starts verifying deliveries with that secret. The dashboard step is gone.
- The secret is in Alchemy state, as Stripe's own resource already stores it (`Redacted`). A
  deployment that must not persist it passes `webhookSecret` and keeps the endpoint out of state.
- The deploy needs a public origin. Every real deployment states one for checkout return URLs; an
  example that runs on an ephemeral Workers URL is illustrative, not a delivery target.
- `docs/BILLING-SURFACE.md` moves webhooks from "paykit + deployment" to shipped: the endpoint and
  the decoder are ours, the route is the deployment's.
- A rotated secret is a resource update. The endpoint's reconcile writes it, the Worker's environment
  changes with it, and a deployment cannot be half-rotated.
