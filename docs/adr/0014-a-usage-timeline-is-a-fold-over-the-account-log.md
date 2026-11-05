# 0014 — A usage timeline is a fold over the account's log

- **Status:** Accepted
- **Date:** 2026-11-05
- **Follows:** [0006](./0006-postpaid-usage-is-a-unit-price-in-the-catalog.md), [0008](./0008-a-report-names-the-price-each-unit-was-recorded-at.md), [0013](./0013-an-auto-top-up-is-a-purchase-on-a-crossing.md)
- **Supersedes:** none

## Context

When a bill looks wrong, the question is not "what is my standing now" — `Entitlements` answers
that — and it is not "why is this account on X" — `Preview` answers that. It is "what changed, and
what did each change cost". The answer is already in `AccountEvents`: every usage fact, hold,
credit move, tier change and period close is recorded there, in order, with its money.

What is missing is a shape a person can read. The raw stream is a list of tagged event bodies; the
views fold it into current numbers and lose the sequence; the billing read row is one account. A
bill dispute needs the sequence and the per-feature, per-period totals together, and it must agree
with the ledger exactly.

Three ways to build it were on the table: a view with a bounded array of entries, a projection
writing a `billing_rm_timeline` table, or a pure fold over the log. The first makes every event's
view snapshot carry the whole array (a view stores its state after each event), the second
duplicates a log that already exists and adds a table, a migration and a store to provide. The
third needs nothing new: the stream is the record, and a fold is the read.

## Decision

**1. The timeline is a pure fold over the account's stream, not a stored read model.**
`timelineOf(inputs)` and `appendTimeline(timeline, input)` take `{ event, envelope }` entries —
exactly what `AccountEvents` yields — and return `UsageTimeline`. There is no table, no view
snapshot, no migration and no second store. A consumer that already holds the events (the console,
an export, a test) derives the timeline in memory; a consumer that does not holds the stream.

**2. One entry per billing fact.** A usage record, a hold, a settle, a release, a credit grant, a
purchase, a spend, an expiry, a payment, a payment failure, a proration invoice, a tier change, a
start or a period close becomes one entry. The entry copies the event's numbers — `amount` in the
feature's unit, `credits` in the pool, `charge` in minor units — and never recomputes them. `holdId`,
`tier` and `invoiceId` are the links back to the entity or the provider record; `kind` is what a
console groups and colours by.

**3. Each entry is stamped with the period that was open when the log recorded it.** An entry
before a plan exists (a pack bought into an empty account) has no period, which is the truth. A
close's expiry follows the boundary in the log, so the new period owns it: the fold reads order,
not intent. The
period rollup is a sum of the same entries: per feature, units, credits spent, money charged, and
the units its holds kept, settled and released; per period, credits granted, purchased, spent,
expired and the last balance. A total cannot disagree with the entries because it is folded from
them, and a reader can check one against the other.

**4. The fold is ordered and idempotent.** `lastSeq` makes a redelivered event a no-op, so an
at-least-once feed does not double a charge. It also means the fold must start at the account's
first event: the period an entry belongs to comes from the activation and close events before it.
A snapshot that resumes a cursor must carry the timeline folded to that cursor.

**5. The timeline is not a source of truth.** Nothing in `decide`, `check`, `Allowance` or `Verify`
reads it, and it adds no number an event did not carry. A grant the log does not record (a
scheduled tier's boundary pool, if a projection ever stops recording it) is not in the timeline
either — the visible consequence that keeps the log the record.

**6. The console folds the feed it already watches.** `paykit-admin` gets a Timeline panel from the
same `AccountEvents` subscription that fills its raw Events panel; there is no new read API, RPC or
store. The raw panel stays: the timeline is the readable slice, not a replacement for the audit
trail.

## Slices

### 1 — the fold and the console panel

Landed: `Timeline.ts` (`AccountEvent`, `TimelineEntry`, `TimelineFeature`, `TimelinePeriod`,
`UsageTimeline`, `timelineOf`, `appendTimeline`, `initialTimeline`); the console's account state
carries the fold, and the Timeline panel shows periods and the newest entries. Tests cover the
order, the per-feature and per-credit rollups, a redelivery, a pre-plan purchase, a trial extension
and an empty log, plus the console's incremental fold.

### 2 — not in this slice

A server-side paged timeline for an account with more events than a browser should hold, a
per-dimension grouping (the dimension is on the hold and the command, not on `UsageRecorded`; the
event's `unitPrice` is the price that was recorded), and a cross-account timeline (`BillingRead`
is the cross-account read; a timeline is one account's story).

## Consequences

- **No migration and no new store.** A host that provides `BillingReadStore` and the model gets the
  timeline from the stream it already serves.
- **The console pays an array copy per event.** For a console holding an account's log this is the
  same order as the raw Events panel; a million-event account is a case for the server-side slice,
  not for a bigger fold.
- **The log stays the audit trail.** The timeline can be rebuilt from the stream at any moment, and
  deleting it would lose only the convenience.
- **The per-period totals are a second fold of numbers `Entitlements` also holds.** They are derived
  from the entries, not copied from the view, so the two can be compared; a disagreement is a bug
  in one of them, not a reason to make one authoritative.

## Alternatives considered

- **A view with a bounded entry array.** The view state after every event would carry every entry,
  so a busy account writes tens of kilobytes per usage record. Rejected: the cost is invisible
  until production and the bound loses the history the screen exists for.
- **A `billing_rm_timeline` projection and table.** It duplicates the event log, needs a migration,
  a store a host must provide, and a second definition of "the period this belongs to". Rejected
  while the stream is already there; a paged server-side read can be added later without changing
  the fold.
- **A second stream of timeline entries.** The same duplication with a stream's shape, and two
  places that have to agree on what an entry is.
- **Folding in the view layer.** The console's render would decode and re-fold the whole feed on
  every paint; the state is a cheaper place, and the pure fold is usable outside the console.

## What would reopen this

- An account with more events than a browser should hold: a paged store fed by the same entry
  definition.
- A per-dimension or per-price breakdown of the timeline: a field on the entry that the event
  already carries, or a new event field.
- A cross-account "what changed" query: `BillingRead` and `List` own cross-account reads, and a
  timeline that spans accounts would be a new projection, not a wider fold.
