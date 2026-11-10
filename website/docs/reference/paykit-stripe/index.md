---
title: "Paykit Stripe"
description: "Stripe for paykit: a processor in one call."
sidebar:
  label: Overview
---

Stripe for paykit: a processor in one call.

## Entry points

| Import | Source |
| --- | --- |
| `@potion.run/paykit-stripe` | [`src/index.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-stripe/src/index.ts) |

## Modules

- [MeteredPrice](/reference/paykit-stripe/metered-price): A Stripe metered price that states more than one unit amount: a package transform or a graduated/volume ladder.
- [RetiredPrices](/reference/paykit-stripe/retired-prices): Turn off the Stripe prices a stage still has active that its catalog no longer declares.
- [Stripe](/reference/paykit-stripe/stripe): Stripe as a processor, ready for Paykit.BillingStack.
- [StripeBilling](/reference/paykit-stripe/stripe-billing): Stripe provisioning and the Stripe provider in one call.
- [StripePrices](/reference/paykit-stripe/stripe-prices): The price resources a tier is sold through, reconciled from the catalog.
- [stripeWebhook](/reference/paykit-stripe/stripe-webhook): Verify and translate one Stripe webhook into paykit's provider-neutral event.
