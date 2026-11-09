// Named scenarios for `money.qnt`. Each run is a claim about the accept-set:
// the invoice and refund paths that must exist, and the ones that must be
// refused. A `.fail()` step ends the run because a refused action leaves no
// state behind.
//
// Run: `quint test specs/paykit/money_test.qnt --main=money_test`
module money_test {

  import money.* from "./money"

  // ── refunds ────────────────────────────────────────────────────────────────

  run refundTest =
    init
      .then(charge(100))
      .then(refund("r1", 40))
      .expect(state.charged == 100 and state.refunded == 40)
      .expect(state.refunds.get("r1").amount == 40)
      .expect(refundedIsOutstanding)
      .expect(moneyInvariant)

  // The ceiling is the money the log recorded as charged.
  run refundCeilingTest =
    init
      .then(charge(100))
      .then(refund("r1", 101).fail())

  // A key records one refund; a retry is the same record, not a second one.
  run refundKeyIsSingleTest =
    init
      .then(charge(100))
      .then(refund("r1", 40))
      .then(refund("r1", 10).fail())

  // Two keys are two refunds, and between them they still cannot exceed the
  // charge.
  run twoRefundsShareTheCeilingTest =
    init
      .then(charge(100))
      .then(refund("r1", 60))
      .then(refund("r2", 60).fail())

  run reverseTest =
    init
      .then(charge(100))
      .then(refund("r1", 80))
      .then(reverse("r1", 30))
      .expect(state.refunded == 50)
      .expect(state.refunds.get("r1").reversed == 30)
      .expect(refundedIsOutstanding)
      .expect(moneyInvariant)

  // The cap is the refund, not the currency: a reversal cannot exceed the
  // refund it names.
  run reversalCeilingTest =
    init
      .then(charge(100))
      .then(refund("r1", 80))
      .then(reverse("r1", 81).fail())

  // A fully reversed refund has no outstanding amount left.
  run fullReversalTest =
    init
      .then(charge(100))
      .then(refund("r1", 80))
      .then(reverse("r1", 80))
      .expect(state.refunded == 0)
      .expect(state.refunds.get("r1").reversed == 80)
      .expect(refundedIsOutstanding)
      .then(reverse("r1", 1).fail())

  // The headroom a reversal returns can be refunded again.
  run reversalRestoresHeadroomTest =
    init
      .then(charge(100))
      .then(refund("r1", 100))
      .then(reverse("r1", 40))
      .then(refund("r2", 40))
      .expect(state.refunded == 100)
      .expect(state.refunds.get("r2").amount == 40)
      .expect(refundedIsOutstanding)
      .expect(moneyInvariant)

  // A refund is a record, not a negative charge: `charged` never moves.
  run refundKeepsChargedTest =
    init
      .then(charge(100))
      .then(refund("r1", 40))
      .expect(state.charged == 100)
      .expect(moneyInvariant)

  // ── tier proration identity ───────────────────────────────────────────────

  run prorationInvoiceTest =
    init
      .then(changeTier(100))
      .then(invoiceProration(1, 100))
      .expect(prorationBilled)
      .expect(state.charged == 100 and state.invoiced == 100)
      .expect(state.lastInvoiceId == 1 and state.lastInvoiceAmount == 100)
      .expect(moneyInvariant)

  // An invoice may settle only the amount the current proration moved.
  run prorationInvoiceAmountMismatchTest =
    init
      .then(changeTier(100))
      .then(invoiceProration(1, 99).fail())

  // An invoice bills the proration once.
  run prorationInvoiceOnceTest =
    init
      .then(changeTier(100))
      .then(invoiceProration(1, 100))
      .then(invoiceProration(1, 100).fail())

  // A non-positive proration is a credit, not money to collect.
  run prorationCreditIsNotInvoicedTest =
    init
      .then(changeTier(-50))
      .then(invoiceProration(1, 50).fail())

  // A change replaces the old proration. An invoice for the old id can never
  // settle the new one, even when the money is identical.
  run staleProrationInvoiceTest =
    init
      .then(changeTier(100))
      .then(changeTier(100))
      .expect(state.nextProrationId == 3)
      .then(invoiceProration(1, 100).fail())

  run currentProrationInvoiceTest =
    init
      .then(changeTier(100))
      .then(changeTier(100))
      .then(invoiceProration(2, 100))
      .expect(prorationBilled)
      .expect(state.lastInvoiceId == 2)
      .expect(moneyInvariant)

  // A stale id whose amount is smaller than the new due cannot underbill it.
  run staleProrationReplacementTest =
    init
      .then(changeTier(100))
      .then(changeTier(150))
      .then(invoiceProration(1, 100).fail())

  run currentProrationReplacementTest =
    init
      .then(changeTier(100))
      .then(changeTier(150))
      .then(invoiceProration(2, 150))
      .expect(state.invoiced == 150)
      .expect(moneyInvariant)

  // ── quantity proration ─────────────────────────────────────────────────────

  run quantityInvoiceTest =
    init
      .then(setQuantity("q1", 80))
      .then(invoiceQuantity("q1", 80))
      .expect(state.quantity.get("q1").invoiced)
      .expect(state.quantity.get("q1").invoiceAmount == 80)
      .expect(state.charged == 80)
      .expect(moneyInvariant)

  // A reduction is a credit. The command layer must refuse to invoice it even
  // though the binding also checks `due > 0` before it calls.
  run quantityCreditIsNotInvoicedTest =
    init
      .then(setQuantity("q1", -80))
      .then(invoiceQuantity("q1", 80).fail())

  run quantityInvoiceAmountMismatchTest =
    init
      .then(setQuantity("q1", 80))
      .then(invoiceQuantity("q1", 70).fail())

  run quantityInvoiceOnceTest =
    init
      .then(setQuantity("q1", 80))
      .then(invoiceQuantity("q1", 80))
      .then(invoiceQuantity("q1", 80).fail())

  // A key owns one change: a second `SetQuantity` with the same key is a
  // replay, not a second proration under the same id.
  run quantityKeyIsSingleTest =
    init
      .then(setQuantity("q1", 80))
      .then(setQuantity("q1", 10).fail())

  // A credit that was never invoiced is still a credit after another change.
  run quantityCreditStaysCreditTest =
    init
      .then(setQuantity("q1", -80))
      .then(setQuantity("q2", 40))
      .expect(quantityCreditRecorded)
      .expect(quantityCreditUninvoiced)
      .expect(moneyInvariant)
}
