---
title: "Portal"
description: "Exports `Portal`, `ChargeProration`."
---

> **Source:** [`packages/paykit/src/Billing/Portal.binding.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/Portal.binding.ts#L67)

## Portal

> **Kind:** Binding · **Product:** Payments · **Provides:** `Paykit.Portal`

Open the provider's customer portal, when it has one. The portal belongs to
the provider the account already pays through, so the standing picks it and
only that provider's layer is provided for the call.

### Sending a customer to their invoices

```typescript
const portal = yield* Paykit.Portal(account);
const { url } = yield* portal();
return Response.redirect(url);
```

## ChargeProration

> **Kind:** Binding · **Product:** Payments · **Provides:** `Paykit.ChargeProration`

Charge the money a mid-cycle tier change moved. `ChangeTier` records the
proration and `Preview` shows it; neither collects it, because `decide` is
pure and only an effect can ask a provider for an invoice.

Three rules: only a positive `due` is charged (a downgrade's credit is applied
by the next period), it happens once (the invoice id is recorded, so a second
call answers `nothing`), and the log carries the money — a `RecordProrationInvoice`
command, not a side effect.

### Collecting an upgrade

```typescript
const chargeProration = yield* Paykit.ChargeProration(account);
const charged = yield* chargeProration();
if (charged.outcome === "charged") notify(charged.invoiceId);
```
