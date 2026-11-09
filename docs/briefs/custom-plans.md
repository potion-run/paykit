# Brief — per-customer custom plans

This is the working plan for the custom-plan slice: a plan whose allowances a customer may hold
bespoke. It is a brief, not an ADR: the decisions are in
[0041](../adr/0041-a-custom-plan-is-a-catalog-opt-in.md). Where this brief and the ADR disagree, the
ADR wins.

It closes the queue item in [NEXT](../NEXT.md) ("Per-customer custom plans") and the `missing` row in
[BILLING-SURFACE](../BILLING-SURFACE.md). No code, comment, doc or test names the product this API is
modelled after.

## Rules

- **The opt-in is catalog data.** `Plan.custom` is set where the price is stated, once per plan. No
  request can opt itself into a weaker guard, and a deployment that sells no custom plan accepts no
  bespoke allowance.
- **The grants are defaults, not the boundary.** A custom plan's `grants` are the quote a caller gets
  when it states none. The boundary is structural: declared feature, catalog-valid plan item, the
  catalog price or the operation's explicit negotiated price, and exact credit terms.
- **One structural rule, two callers.** `CatalogGuard` (wire callers) and the plan bindings
  (in-process callers) call the same pure `catalogMismatchOf`, which calls the same
  `allowanceFaultOf` the deploy does. A rule added to the catalog is a rule a bespoke request must
  satisfy, without a second copy.
- **`decide` stays pure.** The bespoke allowances ride the command and the event. Nothing in
  `decide`, `evolve` or a view reads the catalog.
- **A custom plan is a plan.** Same group, same credits, same proration, same scheduling, same
  cancellation. The price is the catalog's unless the operation states the negotiated one, and the
  allowances are the catalog's unless the operation states the bespoke set.
- **No event is renamed or repurposed.** `SubscriptionActivated`, `PlanChanged` and
  `PlanChangeScheduled` already carry `allowances` and the price; the activation events add nothing.
  `ProviderRefAttached` gains the pending quote (ADR 0042 §1), which is how the completion reads
  terms the catalog cannot state.
- **No model change.** `specs/paykit/*.qnt` has never held the catalogue, and no command or decision
  changed, so there is no action, invariant, mutant or coverage row to add. `pnpm spec` is a gate on
  not having broken one.

## Status

Landed, then extended by
[ADR 0042](../adr/0042-quoted-terms-bespoke-add-ons-and-a-negotiated-price.md), with the two
follow-ups decided by [ADR 0043](../adr/0043-a-custom-plan-may-be-a-groups-fallback.md) and
[ADR 0044](../adr/0044-a-quote-is-keyed-by-the-purchase-it-was-quoted-for.md). The first slice is
[ADR 0041](../adr/0041-a-custom-plan-is-a-catalog-opt-in.md): `Tier.custom` on the plan schema (the
public spelling is `Plan.custom`), `CatalogFacts` / `allowanceFaultOf` as the one per-item rule
`defineCatalog` and the guard both run, the pack catalog refusal (`CatalogCustomPack`),
`sameAllowances` and the guard's structural
branch, `TierCommand.withGrants`, and an optional `grants` on `AttachRequest`,
`PreviewAttachRequest`, `SubscribeRequest`, `ChangeTierRequest` and
`ScheduleTierChangeRequest`, joined in both the in-process and the Api bindings.

ADR 0042 closes the three gaps this brief left open:

- **Quoted terms across a checkout.** `Subscribe` writes a `PendingActivation` beside the provider
  reference; `ProviderRefAttached` carries it into state, and the webhook activates exactly that
  set. A custom plan with no quote is `PendingActivationMissing`; a quote for another plan is
  `PendingActivationStale`. `custom_plan_checkout` is gone.
- **Bespoke add-ons.** `custom: true` with `addOn: true` is accepted, and a custom add-on stacks
  through the ordinary attach path. `CatalogCustomAddOn` is gone. The per-plan balance source landed
  beside it: each plan is its own `Balance.breakdown` row, and a spend consumes them in plan-set
  order.
- **A negotiated price.** `price` is optional on the attach, preview and plan-verb requests, and the
  guard accepts it on a custom plan as the explicit override. The event already carries it
  (`SubscriptionActivated.price`, `PlanChanged.priceAfter`, `PlanChangeScheduled.price`). A first
  activation at an amount the catalog does not state is invoiced, because the checkout port sells the
  vendor's price object rather than an amount.

- **A custom plan as a group's fallback.** [ADR
  0043](../adr/0043-a-custom-plan-may-be-a-groups-fallback.md) removes `CatalogCustomDefaultPlan`: a
  custom plan may be a group's `isDefault`, and a cancellation re-grants the catalog's terms through
  `defaultPlanFor`/`planTermsOf`, never the bespoke set the customer held. An add-on cannot be a
  default (`CatalogDefaultOnAddOn`), and a variant does not inherit `isDefault`.
- **A quote keyed by its purchase.** [ADR
  0044](../adr/0044-a-quote-is-keyed-by-the-purchase-it-was-quoted-for.md) replaces the single
  `pendingActivation` with `pendingActivations`, keyed by the provider reference of the purchase.
  `Payments.createCheckout` returns the vendor reference, `WebhookEvent` names it, and a completion
  that names no quote while several are held is `PendingActivationAmbiguous` (409).

The per-plan balance source landed with it: a stacked bespoke item has its own
`Balance.breakdown` row, a spend consumes the plan sources in plan-set order before a standalone
grant, and a second add-on adds its grant to the feature instead of resetting the balance. A
feature's spend path still reads the one merged plan item.

Tests: `test/billing/CustomPlans.test.ts`, `test/billing/CustomBalance.test.ts`,
`test/catalog/Guard.test.ts`, `test/Catalog.test.ts`, `test/Types.test.ts`,
`test/subscribe/Subscribe.test.ts`, and the vendor packages' `test/Webhooks.test.ts` files.

## Target surface

```ts
import * as Effect from "effect/Effect";
import * as Paykit from "@potion.run/paykit";

const messages = Paykit.feature({ id: "messages", name: "Messages" });
const seats = Paykit.feature({ id: "seats", name: "Seats", kind: "non_consumable" });

// A plan whose grants are the quote, not the ceiling.
const enterprise = Paykit.plan({
  id: "enterprise",
  name: "Enterprise",
  custom: true,
  price: { amount: 4_000_000, currency: "usd", interval: "annual" },
  credits: 500_000,
  grants: [
    Paykit.planItem(messages, { included: 150_000, overage: "bill" }),
    Paykit.planItem(seats, { included: 25, overage: "bill", unitPrice: { amount: 1_500, currency: "usd" } }),
  ],
});

// The bespoke deal: anything declared, in a shape the catalog would accept.
const grants = [
  Paykit.planItem(messages, { included: 400_000, overage: "bill" }),
  Paykit.planItem(seats, { included: 1_200, overage: "bill", unitPrice: { amount: 1_200, currency: "usd" } }),
];

// The negotiated price is the operation's, not the catalog's; the event keeps it.
const price = { amount: 4_200_000, currency: "usd", interval: "annual" } as const;

const deal = (account: string) =>
  Effect.gen(function* () {
    // the plan operation — the supported surface
    const attach = yield* Paykit.Attach(account);
    yield* attach({ planId: "enterprise", grants, price, idempotencyKey: "deal-1" });

    // what the same call would record, decided without writing
    const previewAttach = yield* Paykit.PreviewAttach(account);
    const preview = yield* previewAttach({ planId: "enterprise", grants, price });

    // the low-level verbs carry the same fields
    const changeTier = yield* Paykit.ChangeTier(account);
    yield* changeTier({ tier: "enterprise", grants, price, dedupeKey: "deal-2" });

    // the read answers with the deal, not the catalog
    const check = yield* Paykit.Check(account);
    const { balance } = yield* check({ featureId: "messages" });
    balance.granted; // 400_000

    return preview;
  });
```

What a caller may not do:

| Request | Answer |
| --- | --- |
| `grants` for a feature the catalog never declared | `CatalogMismatch` — `field: "allowances"`, `actual: "CatalogUnknownFeature"` |
| `grants` on a plan without `custom: true` | `CatalogMismatch` — the exact-match rule, unchanged |
| `grants` that name one feature twice | `CatalogMismatch` — one plan item per feature |
| `grants` for a custom plan whose price/credits/expiry/top-up/rates disagree | `CatalogMismatch` on that field |
| `grants` shaped against a rule the catalog would refuse (`cap` without a bill, a flag granted as metered, `"unlimited"` with a bill, …) | `CatalogMismatch` — `actual` is the catalog rule's tag |
| a plan item that does not decode as `Allowance` | schema failure at the command boundary, not a refusal |
| a `price` on a plan that is not custom | `CatalogMismatch` — `field: "price"`, the exact rule |
| a custom completion with no stored quote | `PendingActivationMissing` at the webhook edge |
| a custom completion whose quote names another plan | `PendingActivationStale` at the webhook edge |

## The guard rule

`catalogMismatchOf(catalog, input)`, in order, for an input that names a `tier`:

1. the plan exists (`field: "tier"`), else `CatalogMismatch`;
2. **allowances** — if the plan is **not** custom, the command's set must equal the catalog's
   `planItemsOf` key-for-key and field-for-field (`field: "allowances"`); if the plan **is** custom,
   each entry must (a) sit under its own `feature` id, (b) name a declared feature, (c) return `null`
   from `allowanceFaultOf` — the same per-item rules the deploy runs — and the set must be non-empty.
   A violation is `CatalogMismatch({ tier, feature, field: "allowances", expected, actual })`, where
   `expected` is `"a valid catalog plan item"` or `"one plan item per feature"` and `actual` is the
   catalog rule's tag (`CatalogCapWithoutBilling`, …) or `"missing"` / `"duplicate"`;
3. **price** — the command's price must equal the plan's price in the command's currency
   (`field: "price"`);
4. **credits**, **creditsExpire**, **topUp**, **rates** — exact, for both kinds of plan.

Steps 3–4 are today's code, unmoved, so a custom plan is exactly as strict about money as a fixed
one.

## The decide table

`decide` is untouched. This slice changes what may reach it, not what it does with it.

| Step | Who | Reads | Writes | Refuses |
| --- | --- | --- | --- | --- |
| `TierCommand.withGrants(catalog, terms, grants)` | every plan binding | the catalog | — | `CatalogMismatch` |
| `Attach` (activate) | `Subscribe` binding → `Subscribe` command | the catalog, the standing | `SubscriptionActivated` | `CatalogMismatch`, `AlreadySubscribed` |
| Checkout completion | `Webhook` → `Subscribe` command | the stored quote first, the catalog only when none | `SubscriptionActivated` | `PendingActivationMissing`, `PendingActivationStale`, `PlanNotInCatalog` |
| `Attach` (move now) | `ChangeTier` binding → `ChangeTier` command | the catalog, the standing, `prorate` | `PlanChanged` | `CatalogMismatch`, `DowngradeBelow*`, `ProrationMismatch`, `CurrencyMismatch` |
| `Attach` (boundary) | `ScheduleTierChange` binding → command | the catalog, the standing | `PlanChangeScheduled` | `CatalogMismatch`, `PlanPhaseNotFuture`, `PlanPhaseNamesAddOn`, `CurrencyMismatch` |
| `Attach` (cancel) | `CancelImmediately` / `ScheduleCancellation` | the standing | `SubscriptionCanceled` | `StandingEnded` |
| `PreviewAttach` | `Preview` | the catalog, the standing | nothing | the same refusals, decided not recorded |

`decide` reads the allowances the command carries, so a bespoke deal is indistinguishable from a
catalog one at the model boundary: the ceilings (`cap`, `moneyCap`), the reset windows, the overage
behaviour and the quantity rules are the ones the event recorded.

## Catalog rules

| Rule | Tag | Why |
| --- | --- | --- |
| `custom` on a `kind: "one_off"` pack | `CatalogCustomPack` | a pack grants nothing, so nothing is bespoke |
| `custom` with `addOn: true` | accepted | it is a custom plan that stacks; each plan is its own `Balance.breakdown` source (ADR 0042 §2) |
| `custom` with `isDefault: true` | accepted | a fallback is still the catalogue's terms: `defaultPlanFor` resolves `planTermsOf`, so a cancellation never re-grants a bespoke set (ADR 0043) |
| `addOn: true` with `isDefault: true` | `CatalogDefaultOnAddOn` | an add-on fills no group, so it can never be a fallback (ADR 0043) |
| a variant of a custom plan | `custom` inherited, `isDefault` not | `mergeVariant` keeps the base's `custom` and drops the base's `isDefault`; a variant of a non-custom base cannot add `custom` (ADR 0043) |

## Test matrix

| Case | File | Proves |
| --- | --- | --- |
| a bespoke set is accepted (more, fewer, and different items than the defaults) | `test/catalog/Guard.test.ts` | the structural rule and that the defaults are not a boundary |
| an undeclared feature is refused | `test/catalog/Guard.test.ts` | `CatalogMismatch` / `CatalogUnknownFeature`, and the plan is named |
| an item the catalog would refuse is refused | `test/catalog/Guard.test.ts` | `CatalogCapWithoutBilling`, `CatalogFlagOnMetered` via `actual` |
| a bespoke set on a fixed plan is refused | `test/catalog/Guard.test.ts` | the non-custom rule survives |
| price, credits, expiry, top-up and rates are still exact on a custom plan | `test/catalog/Guard.test.ts` | money is not negotiable by the allowance door |
| `custom` round-trips the public constructor; a variant inherits it | `test/Plan.test.ts` | `Paykit.plan({ custom: true })`, `Plan.custom` |
| the catalog refusals, a custom add-on and a custom fallback accepted | `test/Catalog.test.ts` | `CatalogCustomPack`, `CatalogDefaultOnAddOn`, `custom` + `addOn`, and `custom` + `isDefault` |
| a custom plan attaches with a bespoke set | `test/billing/CustomPlans.test.ts` | `SubscriptionActivated.allowances` and `state.plans[id].allowances` are the deal |
| `check` and `BillingState` report the deal | `test/billing/CustomPlans.test.ts` | the read model folds the event, not the catalog |
| an undeclared feature is refused end to end | `test/billing/CustomPlans.test.ts` | no event recorded, `CatalogMismatch` |
| a move to and from a custom plan | `test/billing/CustomPlans.test.ts` | `PlanChanged` carries the bespoke set; a move back records the catalog's |
| the same plan with a new bespoke set | `test/billing/CustomPlans.test.ts` | it is a move, not a replay: scheduled by default, then immediate on request |
| a scheduled custom phase freezes the terms | `test/billing/CustomPlans.test.ts` | `PlanChangeScheduled.allowances`, `pendingPlanOf(state)` |
| a priced custom attach carries the quote through a checkout | `test/billing/CustomPlans.test.ts` | `pendingActivations[reference]` on state, then `SubscriptionActivated.allowances` from the quote |
| a custom completion with no quote, or a quote for another plan | `test/billing/CustomPlans.test.ts` | `PendingActivationMissing`, `PendingActivationStale`, no standing recorded |
| two concurrent checkouts, completed oldest first | `test/billing/CustomPlans.test.ts` | the older quote activates; every quote is cleared (ADR 0044) |
| two quotes and a completion with no reference | `test/billing/CustomPlans.test.ts` | `PendingActivationAmbiguous` (ADR 0044) |
| a custom fallback re-grants the catalog's terms | `test/billing/CustomPlans.test.ts` | the frozen `fallback` row and the boundary carry the floor's grants, price and credits (ADR 0043) |
| a negotiated price on a checkout and on a move | `test/billing/CustomPlans.test.ts` | `pendingActivations[reference].price`, `state.plans[id].price`, `PlanChanged.priceAfter` |
| a bespoke add-on stacks beside the base plan | `test/billing/CustomPlans.test.ts` | `PlanChanged.addOn`, both plan rows, the merged allowances |
| two bespoke add-ons grant one feature | `test/billing/CustomBalance.test.ts` | one `Balance.breakdown` row per plan, a spend consumes them in plan-set order, and `check` / `allowed` agree |
| replay reproduces the deal | `test/billing/CustomPlans.test.ts` | folding `AccountEvents` rebuilds the same plan row |
| a wire caller gets the same guard | `test/Api.test.ts` | `BillingApi.clientInProcess` `ChangeTier` with bespoke items, and the refusal for an undeclared feature |

## Files to touch, in dependency order

| # | File | Change |
| --- | --- | --- |
| 1 | `packages/paykit/src/Tier.ts` | `Tier.custom`, `SubscriptionTierInput.custom`, `custom?: never` on the pack and variant inputs, copied by `tier()` |
| 2 | `packages/paykit/src/Catalog.ts` | `CatalogFacts` + `catalogFactsOf` + `allowanceFaultOf` (extracted from the tier loop), the three custom refusals, the union |
| 3 | `packages/paykit/src/CatalogGuard.ts` | the custom branch, `sameAllowances`, the doc |
| 4 | `packages/paykit/src/TierCommand.ts` | `withGrants` |
| 5 | `packages/paykit/src/Billing/PlanOperationUnsupported.ts` | the refusal moved out of `Attach.binding.ts`, so the purchase path can raise it |
| 6 | `packages/paykit/src/Billing/Subscribe.binding.ts`, `Subscribe.operation.ts` | `grants?`, the priced-bespoke refusal |
| 7 | `packages/paykit/src/Billing/ChangeTier.binding.ts` | `grants?` on the request |
| 8 | `packages/paykit/src/Billing/ScheduleTierChange.binding.ts` | `grants?` on the request |
| 9 | `packages/paykit/src/Billing/Attach.binding.ts` | `grants?` on attach/preview-attach, passed to the three verbs, the preview refusal |
| 10 | `packages/paykit/src/Billing/Preview.operation.ts` | `grants?` on the three plan commands, `CatalogMismatch` in the preview's answer |
| 11 | `packages/paykit/src/Billing/BillingInProcess.layer.ts`, `BillingApi.layer.ts` | apply `withGrants` and pass `CatalogMismatch` through the binding error |
| 12 | `packages/paykit/src/Billing/index.ts`, `src/index.ts` | re-export the moved refusal and the request types |
| 13 | `packages/paykit/src/Subscription/PendingActivation.ts` | `PendingActivation`, `PendingQuote`, `PendingActivations`, `PendingActivationMissing`, `PendingActivationStale`, `PendingActivationAmbiguous` (ADRs 0042, 0044) |
| 14 | `packages/paykit/src/Subscription/AttachProviderRef.command.ts`, `Subscription.state.ts`, `Subscription.aggregate.ts`, `Webhooks.ts` | the quote map rides the reference, the state and the completion |
| 15 | `Attach.binding.ts`, `Preview.operation.ts`, the three verb bindings and layers | `price?`, the quote instead of the checkout refusal, the add-on path |
| 16 | the tests in the matrix | guard, catalog, plan, billing, webhook, Api |
| 17 | `packages/paykit/src/Billing/Cancel.binding.ts` | `defaultPlanFor` ignores add-ons and keeps resolving a custom fallback from `planTermsOf` (ADR 0043) |
| 18 | `packages/paykit-stripe/src/{Stripe,StripeClient,Webhooks}.ts`, `packages/paykit-polar/src/{Polar,PolarClient,Webhooks}.ts` | the checkout reference and the webhook event's `reference` (ADR 0044) |

ADR 0041 changed no command, event, view or spec. ADR 0042 adds `pending` to
`ProviderRefAttached` and `pendingActivation` to the standing; ADR 0044 replaces the single quote
with a map keyed by the provider reference. None changed a decision, and the spec does not model
provider references or the fallback's terms.
