# 0036 — A seat has a purchased quantity and an occupied count

- **Status:** Accepted
- **Date:** 2026-11-10
- **Supersedes:** [0023](./0023-a-seat-is-a-quantity-that-is-set.md) §§4–7
- **Follows:** [0005](./0005-a-spend-cap-is-a-ceiling-in-units.md), [0035](./0035-plans-plan-items-and-balance-sources.md)

## Context

ADR 0023 made a seat a quantity that is set, and the implementation stores that quantity as the
account's count. `remaining` is derived as `cap − quantity`. That conflates three different
numbers:

- the quantity the customer bought,
- the number of seats actually occupied,
- the most the customer may buy.

The conflation makes two ordinary states unrepresentable: lowering the purchased quantity below
the number of people already in the workspace, and a plan change whose new purchase cap is below
the quantity the customer already holds. The implementation's answer today is a refusal or a
clamp, which either takes seats away from people using the product or hides that the account is
over its purchase cap.

## Decision

**1. Keep purchased and occupied separate.** A non-consumable feature has:

- `purchased` — the quantity bought, including the free grant. `SetQuantity` and
  `featureQuantities` write this.
- `occupied` — the quantity in use. `SetUsage` / `balances.update({ usage })` writes this.
- `remaining = purchased − occupied`. It may be negative.
- `cap` — the most that may be purchased. It is a purchase ceiling, not a ceiling on occupied
  seats.

**2. Setting the purchased quantity below occupied is allowed.** It lowers the balance below
zero; it does not remove an occupied seat. `check()` answers `allowed: false` while
`remaining < required`, so new occupancy is blocked and existing occupancy keeps working. The
customer sees a negative remaining and can raise the quantity to recover.

**3. The cap is enforced on purchase, not on the move between plans.** `SetQuantity` refuses a
purchase above `cap`. A plan change keeps the purchased quantity (raising it to the new free
grant when that is larger) even when the new cap is lower; the account is left over its purchase
cap, with a negative or reduced remaining, until it buys down or the plan changes again. Taking
seats away is never a side effect of a plan change.

**4. Occupied is not spent usage.** `TrackUsage` and `Hold` still refuse a non-consumable
feature. Occupancy changes are their own command and event so a period close and a tier change
never reset them.

**5. Proration prices the purchase quantity, not occupancy.** Adding seats prorates the increase
in `purchased`; removing seats prorates the decrease in `purchased`. An occupied seat below a
reduced purchase is not a refund and is not billed again.

## Consequences

- `SubscriptionState.quantities` is no longer the read model's seat count. The state stores
  `purchased` and `occupied`; the read model derives `remaining`.
- The read row carries `quantity` (purchased), `usage` (occupied), `remaining`, `included`, `cap`,
  and `overCap` or a negative remaining.
- `check()` for a seat uses `remaining >= required`, not `cap − purchased`.
- `ChangeTier` no longer refuses a move because the quantity exceeds the new cap, and no longer
  clamps `remaining` to zero.
- The catalog still refuses a quantity with no price when it bills, a quantity with a reset, and
  a quantity with a ladder. Those rules are unchanged.

## What this does not decide

- Assignment of a seat to a named user. That is an entity or a license, not a count.
- A hard block on occupancy above purchase. `check()` blocks new occupancy; an existing user is
  never evicted by the billing layer.
