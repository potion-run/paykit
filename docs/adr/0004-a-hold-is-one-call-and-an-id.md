# 0004 — A hold is one call and an id

- **Status:** Accepted
- **Date:** 2026-11-04
- **Supersedes:** the hold surface of `Reserve`/`Settle`/`Release`
- **Follows:** [0002](./0002-credits-are-the-unit-of-account.md)

## Context

Work whose cost is known before it finishes — an agent turn, a batch, a request that streams tokens
— has to hold capacity so a second caller cannot spend it, then bill what it actually used. Paykit
has that: `Reserve` takes units out of `remaining`, `Settle` bills them, `Release` returns them.

The shape is wrong in three ways.

**A reservation has no identity.** `reserved` is one counter per feature. A caller that reserves 10
for turn A and 10 for turn B cannot settle *A's* 8; the pool amortises them, and whichever settle
arrives first takes its units from everyone. With concurrency this is the bug the hold exists to
prevent, one level up.

**Three calls invite a leak.** Reserve, then settle, then release the unused remainder are three
commands a caller can run in any order and forget one of. The model refuses over-settling, so a
forgotten settle is invisible until someone reads `reserved` and wonders why capacity is missing.

**A credit-priced feature cannot be held at all.** `Reserve`, `Settle` and `Release` answer
`CreditHoldUnsupported`, which is exactly the feature AI work needs most: reserve an estimate
against the pool, settle the actual.

## Decision

**1. A hold is an entity with an id.** `Hold` returns `{ holdId }`; the standing remembers the open
holds with their terms, and `reserved` becomes a projection of them rather than a number a caller
has to keep straight.

**2. One call to create, one to settle, one to release.**

```ts
const { holdId, remaining } = yield* Hold({ account, feature: "ai", amount: 1_000, dimension: "gpt-large" });

yield* Settle({ holdId, amount: 600 });   // bills 600 credits, returns the other 400
// or, when nothing was used
yield* Release({ holdId });
```

`Settle` with no `amount` settles the whole hold. `Settle` returns what it did not bill, in the same
command, so a caller cannot hold and forget: there is no second call to forget.

**3. Idempotent by id.** Settling a settled hold is a replay and records nothing
(`UsageSettled` carries the id, so the command id is derivable). Settling more than the hold holds
is `HoldExceeded`; releasing a settled hold is `HoldSettled`; an id nobody issued is `HoldUnknown`.
A caller learns which of those it did.

**4. Credits hold, and the rate is captured.** A hold on a credit-priced feature reserves
`amount × rate(dimension)` credits, and the rate at hold time is recorded on the hold: the bill at
settle is the price the work was priced at, not whatever the catalog says when it finishes.
Spendable credit becomes `credits − reservedCredits`.

**5. A hold expires.** Every hold records `expiresAt` (default 15 minutes). Settling after it is
`HoldExpired`; releasing after it still returns the units, because a late release is a cleanup and
not a charge. A `HoldSweep` policy schedules a release for `expiresAt`, so a hold that nobody
settles or releases returns its capacity on its own.

**6. The old three commands are deleted, not deprecated.** Nothing is deployed; there is no state to
migrate and no caller to keep working.

## Slices

### 1 — addressable holds

| Piece | Change |
| --- | --- |
| State | `holds: Record<holdId, { feature, amount, dimension?, cost?, at, expiresAt }>`; `reserved` and `reservedCredits` derived from it |
| Events | `UsageReserved` carries the id and terms; `UsageSettled` / `UsageReleased` carry the id |
| Commands | `Hold`, `SettleHold`, `ReleaseHold` replace `ReserveUsage`, `SettleUsage`, `ReleaseUsage` |
| Bindings | `Hold({ account, feature, amount, dimension?, dedupeKey? })` → `{ holdId, remaining }`; `Settle({ holdId, amount? })` → `{ billed, released }`; `Release({ holdId })` → `{ released }` |
| Credits | a hold reserves credits; settle records `UsageRecorded` with its `cost`, so the pool falls at settle |
| Read model | `reserved` per feature unchanged in shape, now derived; `check()` on a credit feature answers from `credits − reservedCredits` |
| Rejections | `HoldExceeded`, `HoldSettled`, `HoldExpired`, `HoldUnknown` |

### 2 — the sweep

A policy that releases holds past `expiresAt`, scheduled the way `PeriodRollover` and `Dunning` are,
so a caller that crashes between hold and settle does not keep capacity forever. Landed as
`HoldSweep` in `src/Subscription/HoldSweep.policy.ts`: it schedules the schedulable `HoldElapsed`
command at the hold's deadline, and the command releases the hold if it is still open.

### 3 — the console

Open holds on the account page, with their age, because a hold an operator cannot see is a support
ticket waiting to be filed.

## Consequences

- **`reserved` stops being written by a command and starts being derived.** A projection that
  counted reservations now counts open holds; replaying the log still reproduces it.
- **A hold is bigger than a counter.** State grows with concurrency rather than per feature. A
  closed hold is removed, and the events remain the audit trail.
- **Settle bills only what it bills.** The unused remainder returns in the same command, so the
  common path is two calls, not three.
- **A rate change mid-flight does not reprice work in flight**, which is the same rule prices
  already follow: the event carries the money it moved.
- **`CreditHoldUnsupported` disappears**, and with it the last capability that refused on a
  credit-priced feature.

## Alternatives considered

- **Keep the feature-level pool and add an id only to the event.** Rejected: the id would name a
  reservation nobody can address, and two concurrent settles would still amortise.
- **Settle the whole hold only, with no partial amount.** Rejected: the entire point is that the
  estimate is not the actual.
- **Make the caller release the remainder themselves.** Rejected: that is the call they forget, and
  it is why capacity leaks today.
- **No expiry, on the grounds that a leaked hold is visible.** Rejected for a library: a crashed
  caller is the normal case, not the exceptional one, and capacity that returns on its own is worth
  one slice.

## What would reopen this

A caller that needs to settle *more* than it reserved — a turn that overshoots its estimate. The
current answer is a second hold or a settle plus a track; a first-class top-up on a hold would
extend this record rather than replace it.
