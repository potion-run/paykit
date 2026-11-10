---
title: "timelineOf"
description: "Fold a log into a timeline."
---

> **Source:** [`packages/paykit/src/Timeline.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Timeline.ts#L621)
> **Kind:** Primitive

Fold a log into a timeline. Feed it from the account's first event: the fold
derives each entry's period from the activation and close events before it,
so a window that starts in the middle has no period to stamp its first
entries with.

## A bill's story, from the events a console already holds

```typescript
const timeline = timelineOf(entries); // [{ event, envelope }, …]
for (const entry of timeline.entries) {
  console.log(entry.at, entry.kind, entry.feature ?? "", entry.credits ?? "", entry.charge ?? "");
}
```
