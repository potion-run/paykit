# 0051 — A pooled draw has one money ceiling

- **Status:** Accepted
- **Date:** 2026-11-11
- **Follows:** [0006](./0006-postpaid-usage-is-a-unit-price-in-the-catalog.md), [0038](./0038-customer-controls-are-state.md), [0040](./0040-an-entity-is-a-scope-not-a-customer.md), [0050](./0050-a-pooled-draw-is-judged-by-the-pools-terms.md)

## Context

[ADR 0050](./0050-a-pooled-draw-is-judged-by-the-pools-terms.md) made a child scope's pooled draw
bill the pool's terms and its own units bill the scope's terms. It did not say how the money plane
judges the two parts together. The code judged each part against its own `moneyCap` and the same
customer `billed` total, so a request that produced two charges could pass two separate checks and
still put the customer's one bill past the ceiling that applies to it. The customer's `spendLimit`
had the same problem: it was one limit, but a split request could meet it twice.

Two per-source money checks against one customer bill are wrong for the same reason two counters
would be: the money plane has one total. Judge each part independently and the sum is never
checked; judge each against the combined charge and the same bill is counted twice and one request
can be refused by two ceilings. A ceiling belongs to the request, and the request has one charge.

## Decision

**1. A split draw is one money request.** A `TrackUsage` request still spends the scope's own
source first and the shared pool for the rest. Each part keeps its own unit, count and pricing
terms, and the event carries the priced lines for both. The money it records is one `charge`.

**2. The combined charge is judged once.** The write compares `billed + ownCharge + poolCharge`
against the effective money ceiling. The effective ceiling is the lowest `moneyCap` among the
sources the request actually draws; a source it does not draw contributes no ceiling, so an
own-only draw is judged by the own cap and a pool-only draw by the pool cap. The customer's
`spendLimit` applies once to the same combined charge. The precedence of
[ADR 0038](./0038-customer-controls-are-state.md) stays: the lower ceiling names the refusal, and
a tie is `MoneyCapExceeded`.

**3. The refusal carries the combined evidence.** `MoneyCapExceeded` and `SpendLimitExceeded`
carry the combined `charge` and the one `billed` total they judged. There is no per-source billed
counter: the log still records one event, one charge and the priced lines, and a replay reproduces
the same bill.

**4. The read row carries a conservative effective cap.** An entity's feature row states the lower
of its own ceiling and the customer's pooled ceiling when the row can draw the pool, because a
scoped `check` must never say yes where `decide` would refuse. The read does not reproduce the
exact per-source split for an arbitrary future amount — that depends on the source balances at the
write — so it may refuse earlier, and the write path is authoritative.

**5. The model states the rule.** `entities.qnt` carries the customer's `billed`, its ceiling and
`billedNeverExceedsCap`; `splitDrawFitsOneCeilingTest` and
`splitDrawPastOneCeilingIsRefusedTest` pin the accept-set. The `spend-passes-the-ceiling` mutant
removes the check and the invariant must fail.

## Consequences

- A split draw can no longer pass each part and fail the whole. `test/billing/Entities.test.ts`
  pins the combined refusal, the exact-cap acceptance, the single spend limit, the own-only and
  pool-only cases, and the conservative entity row.
- A source the request does not draw no longer lowers its ceiling. An entity with a small own cap
  and a large pool cap spends its own units under the own cap, and a draw on the pool alone under
  the pool's.
- The read model is deliberately conservative. A scoped `check` can report less headroom than a
  future split would use, because it cannot know how the amount will divide; it never allows a
  request the write refuses.
- The log keeps its shape. One `UsageRecorded` carries one charge and the lines for each source,
  so there is no second bill to reconcile and no per-source counter to backfill.
- The model's `billedNeverExceedsCap` is the rule, and the mutant is the proof it bites.

## Alternatives considered

- **Two per-source money checks against the same `billed`.** Rejected: the two parts can each fit
  their own cap while their sum passes the customer's one ceiling, and checking each against the
  combined charge counts the same bill twice. It is one request, so it gets one money judgement.
- **Add the ceilings together.** Rejected: a `moneyCap` is a ceiling on the customer's bill, not a
  budget a scope and a pool each bring; adding them would let a split draw bill past either one.
- **A per-source billed counter.** Rejected: it invents a second money total, gives two places for
  a replay to disagree, and the event already carries the one charge.
- **Make the read reproduce the exact split.** Rejected: the split depends on the source balances
  when the request arrives. A conservative effective cap is the only read that cannot over-allow,
  and the write remains the authority.
