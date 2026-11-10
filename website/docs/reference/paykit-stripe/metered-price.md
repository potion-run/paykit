---
title: "MeteredPrice"
description: "A Stripe metered price that states more than one unit amount: a package transform or a graduated/volume ladder."
---

> **Source:** [`packages/paykit-stripe/src/MeteredPrice.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit-stripe/src/MeteredPrice.ts#L127)
> **Kind:** Resource · **Product:** Product

A Stripe metered price that states more than one unit amount: a package
transform or a graduated/volume ladder. It is the shape Alchemy's `Price`
cannot express, kept here so `StripePrices` can reconcile it like any other
price while `Stripe.Price` remains the one-rate path.

The lookup key is the identity; a changed pricing creates a new price and
transfers the key onto it, because Stripe prices are immutable and an
invoice may still reference the old one.
