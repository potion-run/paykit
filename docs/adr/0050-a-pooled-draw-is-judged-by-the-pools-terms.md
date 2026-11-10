# 0050 — A pooled draw is judged by the pool's terms

- **Status:** Accepted
- **Date:** 2026-11-11
- **Follows:** [0002](./0002-credits-are-the-unit-of-account.md), [0005](./0005-a-spend-cap-is-a-ceiling-in-units.md), [0038](./0038-customer-controls-are-state.md), [0040](./0040-an-entity-is-a-scope-not-a-customer.md)

## Context

[ADR 0040](./0040-an-entity-is-a-scope-not-a-customer.md) §3 decides the order a scope spends its
sources in: its own plan, its own rollover, its own expiring grant, its own lifetime grant, and then
the customer's pooled source. It does not decide what the pooled units cost, and the code did not
either. `TrackUsage` built one `JudgedFeature` from the scope's own allowance map. An entity drawing
the pool has no pooled item of its own — the item is the customer's — so the judgement fell back to
`overage: "block"` with the pool's remaining as the count.

Two things followed. A pooled item that bills overage could never bill from a project: the first
unit past the shared pool's included amount was an `AllowanceExceeded`, and a project's turn was
never charged for it. And the customer's `billed` and `spendLimit` never reached a project's
judgement at all, so an org-wide money ceiling only stopped a turn that ran at the org's own scope.
`examples/saas` found both: its project turns could spend the pool but never bill, and its monthly
ceiling was inert for the path the product actually uses.

The model already had the missing fact. `specs/paykit/entities.qnt` carries `pooledSpent` beside
`pooled`, and `docs/NEXT.md` recorded "the pool has no counter for a direct consume" as a spend-path
finding rather than a decision.

## Decision

**1. A pooled draw is judged against the pooled item's terms.** When a child scope spends a feature
the customer pools, the part that comes from the pool is judged by the pool's `overage`, `included`,
`cap`, `pricing`, `moneyCap` and the customer's `spendLimit` — not by the scope's empty allowance.
The scope's own units, spent first, keep their own terms. One request can therefore be two
judgements in one event; the first refusal names the part that refused.

**2. The pool has its own spent count.** `SubscribedState.poolSpent` is the units drawn from the
pooled source this window, and `UsageRecorded.poolDrawn` is the fact that moves it. It resets with
`remaining` on a close and on a plan move, because a new window is a new included amount. It is not
the customer's `used`: that counts the customer's own scope, and one counter cannot answer both
"what did this scope spend" and "how much of the pool's grant is gone". A state written before the
counter falls back to `included - remaining`, which is the same number when no carry is in the
window.

**3. The money plane is the customer's from every scope.** The charge an entity's event records is
the sum of its own part and the pool's part, and it raises the customer's one `billed` total. The
customer's `spendLimit` is copied onto every entity's read row and balance, so a scoped `check()`
reports the same headroom `decide` judges, and a ceiling applies to a project's turn without running
that turn at the org scope.

**4. The pool may go negative when it bills.** A billed allowance's `remaining` is a count, not a
ceiling: the cap is the ceiling ([ADR 0005](./0005-a-spend-cap-is-a-ceiling-in-units.md)). A draw
past the pool's included amount leaves the pooled row negative and a `PricedLine` on the event,
exactly as a postpaid draw on the customer's own item does. The customer's `cap` and `moneyCap` are
what bound it.

## Consequences

- A project's turn bills the shared pool's overage, and the org's ceiling refuses it before the
  model call. `test/billing/Entities.test.ts` pins the charge, the counter and the reset;
  `examples/saas/test/agent.test.ts` pins the end-to-end refusal.
- `Balance` for a scope with no own row still reports the customer's `spendLimit` and its headroom.
- The spec's `pooledSpent` and the code now name the same fact, which removes one of the three
  spend-path findings `docs/NEXT.md` kept open.
- The pool's counter is state, so a replay of an old log starts it at zero and falls back to the
  grant-minus-remaining difference; a window that opened with a carry can under-count that one
  window. A backfill would need the window's starting count, which the log does not carry per
  feature.
- A scope that draws a pool and also holds its own billed item bills each part against its own
  terms, and the event carries the combined charge and the combined priced lines. A consumer that
  wants one rate per line still gets it; a consumer that reads `unitPrice` gets no shortcut when two
  rates are in play.
- The money ceiling that judges a split draw once, and the conservative cap its read row carries,
  are decided in [ADR 0051](./0051-a-pooled-draw-has-one-money-ceiling.md).
