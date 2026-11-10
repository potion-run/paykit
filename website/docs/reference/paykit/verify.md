---
title: "Verify"
description: "Check one account's standing against the catalog and the configured provider."
---

> **Source:** [`packages/paykit/src/Verify.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Verify.ts#L243)
> **Kind:** Primitive

Check one account's standing against the catalog and the configured
provider. A clean account returns `[]`; every finding is a typed mismatch
naming the account, the tier and the provider, so a console can link
straight to it.

`verifyState` is the same check without a store, for `doctor` and tests.

## Finding accounts a checkout abandoned

```typescript
const mismatches = yield* Paykit.Verify({ account });
if (mismatches.some((m) => m._tag === "MissingProviderRef")) {
  yield* reopenCheckout({ account });
}
```
