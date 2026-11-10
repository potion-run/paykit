---
title: "Paykit Polar"
description: "Polar for paykit: a merchant of record in one call."
sidebar:
  label: Overview
---

Polar for paykit: a merchant of record in one call.

## Entry points

| Import | Source |
| --- | --- |
| `@potion.run/paykit-polar` | [`src/index.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-polar/src/index.ts) |

## Modules

- [Meter](/reference/paykit-polar/meter): A Polar meter that sums one feature's billable units.
- [Polar](/reference/paykit-polar/polar): Polar as a merchant of record, ready for Paykit.BillingStack.
- [PolarBilling](/reference/paykit-polar/polar-billing): Polar provisioning and the Polar provider in one call.
- [PolarPrices](/reference/paykit-polar/polar-prices): The Polar products a tier is sold through, reconciled from the catalog.
- [polarProviders](/reference/paykit-polar/polar-providers): Register the Polar provider a stack needs to reconcile PolarPrices.
- [polarWebhook](/reference/paykit-polar/polar-webhook): Verify and translate one Polar webhook into paykit's provider-neutral event.
- [Product](/reference/paykit-polar/product): A Polar product that sells one tier at the price the catalog states.
- [RetiredProducts](/reference/paykit-polar/retired-products): Archive the Polar products a stage still sells that its catalog no longer declares.
