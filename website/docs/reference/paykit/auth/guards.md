---
title: "Guards"
description: "Exports `Session`, `Admin`."
---

> **Source:** [`packages/paykit/src/Auth/Guards.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Auth/Guards.ts#L8)

## Session

> **Kind:** Primitive

The tenant guard: every command and read a signed-in account may reach
declares it. It resolves the caller from the request and provides it as
`Actor`; an `account` actor may only target itself, while an `admin` or the
`system` may target any account.

Provide a Layer in production that reads your own session (a cookie, a
bearer token, a signed header). `InsecureSessionFromHeaders` is the development
implementation.

### Guarding a command

```typescript
export class TrackUsage extends Domain.Command("TrackUsage", {
  target: AccountId,
  input: { feature: Schema.String, amount: Schema.Int },
  events: [UsageRecorded],
  rejects: [AllowanceExceeded, StandingBlocksUsage],
  middleware: [Session],
}) {}
```

## Admin

> **Kind:** Primitive

The operator guard: commands with a blast radius wider than one account —
granting credit, expiring a standing, replaying a charge — declare it. It
requires an actor whose kind is `admin`; a tenant session cannot reach one.
