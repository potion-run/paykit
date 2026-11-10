---
title: "Entities.layer"
description: "Exports `EntitiesRead`, `EntityWrites`, `EntitiesLive`."
---

> **Source:** [`packages/paykit/src/Billing/Entities.layer.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Billing/Entities.layer.ts#L17)

## EntitiesRead

> **Kind:** Primitive

The read an `Entities` verb answers from: one account's billing view, the
same row `Customers.get()` renders. It is a service so the in-process world
and the Api world compose one binding instead of mapping the view twice.

## EntityWrites

> **Kind:** Primitive

The three writes an `Entities` verb makes. A layer implements only the send
and answers the receipt; `EntitiesLive` reads the view it waited for, so both
transports report the state a caller's next read sees.

## EntitiesLive

> **Kind:** Layer · **Product:** Entities · **Provides:** `Paykit.Entities`

A customer's child scopes, composed from the three entity commands and the
billing view they project into. It adds no second model: an entity is a
partition of the customer's aggregate, so every write is one command on that
aggregate and every read is the view it already folded (ADR 0040 §2).
