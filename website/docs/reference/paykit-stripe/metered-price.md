---
title: "MeteredPrice"
description: "A Stripe metered price that states more than one unit amount: a package transform or a graduated/volume ladder."
---

> **Source:** [`packages/paykit-stripe/src/MeteredPrice.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-stripe/src/MeteredPrice.ts#L111)
> **Kind:** Resource · **Product:** Product

A Stripe metered price that states more than one unit amount: a package
transform or a graduated/volume ladder. It is the shape Alchemy's `Price`
cannot express, kept here so `StripePrices` can reconcile it like any other
price while `Stripe.Price` remains the one-rate path.

The lookup key is the identity; a changed pricing creates a new price and
transfers the key onto it, because Stripe prices are immutable and an
invoice may still reference the old one.

The resource declares `retain`: a stack destroy drops Alchemy's state row and
leaves the price in place. `StripePrices` still pipes
`RemovalPolicy.retain` at the call site, and a call site that asks for
`destroy` deactivates the price (`active: false`), because Stripe cannot
delete a price an invoice references.
