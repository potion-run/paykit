---
title: "BillingStack.resource"
description: "The deploy-time billing stack: it records the validated catalog, the provider descriptors and the store kind, retains on removal, and versions that state shape with BILLING_STACK_VERSION."
---

> **Source:** [`packages/paykit/src/BillingStack.resource.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/BillingStack.resource.ts#L116)
> **Kind:** Resource · **Product:** Billing

The deploy-time billing stack: it records the validated catalog, the provider
descriptors and the store kind, retains on removal, and versions that state
shape with `BILLING_STACK_VERSION`.

Reconcile re-validates the catalog and every provider mapping, so a deploy
whose catalog no longer validates fails with a tagged error instead of
recording half a stack. The attrs carry the catalog, the tier ids a console
can list, the provider descriptors and the store kind.

Removal is `retain`: Alchemy drops the recorded state without calling the
provider's (no-op) delete. The event log lives in the store, not in this
resource, so destroying the stack never cancels a subscription, refunds a
charge or deletes a customer.
