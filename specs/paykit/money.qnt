// A Quint model of the billing *money* protocol: what may be refunded, what a
// reversal does to that ceiling, and which tier or quantity proration an
// invoice is allowed to settle.
//
// This is the third protocol of the billing model. `paykit.qnt` models the
// spend path and `standing.qnt` models the phase machine; this models the
// facts that move money without moving an entitlement. The invariant that
// matters is identity: an invoice settles the charge it was opened for, and a
// refund's reversals never exceed the refund.
//
// Source correspondence:
//   charge              ↔ PurchaseCredits.command.ts / PaymentRecorded
//   refund              ↔ Refund.command.ts             (RefundRecorded)
//   reverse             ↔ ReverseRefund.command.ts      (RefundReversed)
//   changeTier          ↔ ChangeTier.command.ts          (TierChanged.proration)
//   invoiceProration    ↔ RecordProrationInvoice.command.ts (ProrationInvoiced)
//   setQuantity         ↔ SetQuantity.command.ts        (QuantityChanged.proration)
//   invoiceQuantity     ↔ RecordQuantityProrationInvoice.command.ts
//                                                          (QuantityProrationInvoiced)
//
// Scope and the code divergences this model names are in README.md beside this
// file. Currency is one unit here: the per-currency ceiling is `Refund.test.ts`'s
// job, and modelling it would add a second dimension without changing the
// identity rules this slice is about.
module money {

  // ── types ──────────────────────────────────────────────────────────────────

  type RefundKey = str
  type QuantityKey = str

  // One refund record. `reversed` is how much of it a provider has taken back;
  // the outstanding amount is `amount - reversed`.
  type RefundRecord = {
    amount: int,
    reversed: int,
  }

  // The one current tier-change proration. A new change replaces it, which is
  // what makes a stale invoice's id stale too. `Billed` carries the amount the
  // invoice settled, so the log can be checked against the charge.
  type Proration =
    | NoProration
    | Owed({ id: int, due: int })
    | Billed({ id: int, due: int })

  // A quantity change's money, keyed by the caller's `dedupeKey`. A positive
  // `due` is collectable; a negative one is a credit and is never invoiced.
  type QuantityProration = {
    present: bool,
    due: int,
    invoiced: bool,
    invoiceAmount: int,
  }

  type State = {
    // Money this account was charged, and money that went back.
    charged: int,
    refunded: int,
    // Every refund, keyed by the command that recorded it.
    refunds: RefundKey -> RefundRecord,
    // The current tier-change proration and the next id a change will take.
    proration: Proration,
    nextProrationId: int,
    // The last tier proration invoice, for the identity invariant. A stale
    // invoice must leave these pointing at the proration it actually settled.
    lastInvoiceId: int,
    lastInvoiceAmount: int,
    // Quantity changes, keyed by the command that recorded them.
    quantity: QuantityKey -> QuantityProration,
    // How much of `charged` came from invoices rather than pack charges. It is
    // a history counter, so a state can be asked whether an invoice was
    // recorded without keeping every past proration.
    invoiced: int,
  }

  // ── the keys ───────────────────────────────────────────────────────────────

  pure val REFUND_KEYS: Set[RefundKey] = Set("r1", "r2", "r3")
  pure val QUANTITY_KEYS: Set[QuantityKey] = Set("q1", "q2", "q3")

  pure val EMPTY_REFUND: RefundRecord = { amount: 0, reversed: 0 }

  pure val EMPTY_QUANTITY: QuantityProration = {
    present: false,
    due: 0,
    invoiced: false,
    invoiceAmount: 0,
  }

  // ── folds over the records ─────────────────────────────────────────────────

  pure def outstandingOf(record: RefundRecord): int = record.amount - record.reversed

  pure def outstandingRefunds(state: State): int =
    REFUND_KEYS.fold(0, (acc, key) => acc + outstandingOf(state.refunds.get(key)))

  // ── what a proration is ────────────────────────────────────────────────────

  pure def isOwed(proration: Proration): bool =
    match proration {
      | Owed(_) => true
      | _ => false
    }

  pure def isBilled(proration: Proration): bool =
    match proration {
      | Billed(_) => true
      | _ => false
    }

  pure def prorationIdOf(proration: Proration): int =
    match proration {
      | NoProration => 0
      | Owed(entry) => entry.id
      | Billed(entry) => entry.id
    }

  pure def prorationDueOf(proration: Proration): int =
    match proration {
      | NoProration => 0
      | Owed(entry) => entry.due
      | Billed(entry) => entry.due
    }

  // An invoice may settle exactly the current owed proration, by its id and
  // its amount. Identity is the whole rule: the amount alone would let an
  // invoice for the previous change settle the next one.
  pure def canInvoiceProration(proration: Proration, id: int, amount: int): bool =
    match proration {
      | Owed(entry) => entry.id == id and entry.due == amount and entry.due > 0
      | _ => false
    }

  // A quantity invoice may settle exactly the pending entry it names, once,
  // and only when the change moved positive money. A credit is never billed.
  pure def canInvoiceQuantity(entry: QuantityProration, amount: int): bool =
    entry.present
      and not(entry.invoiced)
      and entry.due > 0
      and entry.due == amount

  // ── the state ──────────────────────────────────────────────────────────────

  var state: State

  // ── invariants ─────────────────────────────────────────────────────────────

  // Money back never exceeds money in.
  val refundsCoveredByCharges: bool = state.refunded <= state.charged

  // The currency total is the fold of the refunds themselves, so a reversal
  // cannot be recorded on one side only.
  val refundedIsOutstanding: bool = state.refunded == outstandingRefunds(state)

  // A refund's reversals never exceed what it recorded, and never go back.
  val reversalsBounded: bool =
    REFUND_KEYS.forall(key => {
      val record = state.refunds.get(key)
      record.reversed >= 0 and record.reversed <= record.amount
    })

  // Every refund record is either unused or a positive amount. A zero record
  // is the initial value, not a refund an operator recorded.
  val refundAmountsArePositive: bool =
    REFUND_KEYS.forall(key => state.refunds.get(key).amount >= 0)

  // The current tier proration is billed only for positive money, and the last
  // invoice in the log points at the proration it settled.
  val billedProrationIsPositive: bool =
    not(isBilled(state.proration)) or prorationDueOf(state.proration) > 0

  val lastInvoiceMatchesBilled: bool =
    not(isBilled(state.proration))
      or (state.lastInvoiceId == prorationIdOf(state.proration)
        and state.lastInvoiceAmount == prorationDueOf(state.proration))

  // An invoice settles the change that is current. A change takes the next id,
  // so a billed proration whose id is not the last one was settled by a stale
  // invoice.
  val billedProrationIsCurrent: bool =
    not(isBilled(state.proration))
      or prorationIdOf(state.proration) == state.nextProrationId - 1

  // A quantity credit is never invoiced, and an invoice charges exactly the
  // due it names.
  val quantityCreditsNeverInvoiced: bool =
    QUANTITY_KEYS.forall(key => {
      val entry = state.quantity.get(key)
      not(entry.invoiced) or entry.due > 0
    })

  val quantityInvoicesMatchDue: bool =
    QUANTITY_KEYS.forall(key => {
      val entry = state.quantity.get(key)
      not(entry.invoiced) or entry.invoiceAmount == entry.due
    })

  // Invoices are a part of what was charged, and a charge is never negative.
  val invoicedIsPartOfCharged: bool = state.invoiced <= state.charged

  val chargedNeverNegative: bool = state.charged >= 0

  val moneyInvariant: bool = and {
    refundsCoveredByCharges,
    refundedIsOutstanding,
    reversalsBounded,
    refundAmountsArePositive,
    billedProrationIsPositive,
    lastInvoiceMatchesBilled,
    billedProrationIsCurrent,
    quantityCreditsNeverInvoiced,
    quantityInvoicesMatchDue,
    invoicedIsPartOfCharged,
    chargedNeverNegative,
  }

  // ── refunds ────────────────────────────────────────────────────────────────

  pure def canRefund(state: State, key: RefundKey, amount: int): bool = and {
    amount > 0,
    state.refunds.get(key).amount == 0,
    state.refunded + amount <= state.charged,
  }

  pure def recordRefund(state: State, key: RefundKey, amount: int): State = {
    ...state,
    refunded: state.refunded + amount,
    refunds: state.refunds.set(key, { amount: amount, reversed: 0 }),
  }

  pure def canReverse(state: State, key: RefundKey, amount: int): bool = {
    val record = state.refunds.get(key)

    amount > 0 and amount <= outstandingOf(record)
  }

  pure def recordReversal(state: State, key: RefundKey, amount: int): State = {
    val record = state.refunds.get(key)
    {
      ...state,
      refunded: state.refunded - amount,
      refunds: state.refunds.set(key, { ...record, reversed: record.reversed + amount }),
    }
  }

  // ── tier proration ─────────────────────────────────────────────────────────

  // A tier change replaces the old proration. The old id is spent, so an
  // invoice that names it can never settle the new one.
  pure def changedTier(state: State, due: int): State = {
    ...state,
    proration: Owed({ id: state.nextProrationId, due: due }),
    nextProrationId: state.nextProrationId + 1,
  }

  pure def invoicedProration(state: State, id: int, amount: int): State = {
    ...state,
    proration: Billed({ id: id, due: amount }),
    charged: state.charged + amount,
    invoiced: state.invoiced + amount,
    lastInvoiceId: id,
    lastInvoiceAmount: amount,
  }

  // ── quantity proration ─────────────────────────────────────────────────────

  pure def applySetQuantity(state: State, key: QuantityKey, due: int): State = {
    ...state,
    quantity: state.quantity.set(key, {
      present: true,
      due: due,
      invoiced: false,
      invoiceAmount: 0,
    }),
  }

  pure def applyInvoiceQuantity(state: State, key: QuantityKey, amount: int): State = {
    val entry = state.quantity.get(key)
    {
      ...state,
      charged: state.charged + amount,
      invoiced: state.invoiced + amount,
      quantity: state.quantity.set(key, {
        ...entry,
        invoiced: true,
        invoiceAmount: amount,
      }),
    }
  }

  // ── actions ────────────────────────────────────────────────────────────────

  action charge(amount: int): bool = all {
    amount > 0,
    state' = { ...state, charged: state.charged + amount },
  }

  action refund(key: RefundKey, amount: int): bool = all {
    canRefund(state, key, amount),
    state' = recordRefund(state, key, amount),
  }

  action reverse(key: RefundKey, amount: int): bool = all {
    canReverse(state, key, amount),
    state' = recordReversal(state, key, amount),
  }

  action changeTier(due: int): bool = all {
    state' = changedTier(state, due),
  }

  action invoiceProration(id: int, amount: int): bool = all {
    canInvoiceProration(state.proration, id, amount),
    state' = invoicedProration(state, id, amount),
  }

  action setQuantity(key: QuantityKey, due: int): bool = all {
    not(state.quantity.get(key).present),
    state' = applySetQuantity(state, key, due),
  }

  action invoiceQuantity(key: QuantityKey, amount: int): bool = all {
    canInvoiceQuantity(state.quantity.get(key), amount),
    state' = applyInvoiceQuantity(state, key, amount),
  }

  action step: bool = {
    nondet key = REFUND_KEYS.oneOf()
    nondet quantityKey = QUANTITY_KEYS.oneOf()
    nondet amount = 1.to(200).oneOf()
    nondet rawDue = 0.to(200).oneOf()
    nondet id = 0.to(4).oneOf()
    any {
      charge(amount),
      refund(key, amount),
      reverse(key, amount),
      changeTier(rawDue - 100),
      invoiceProration(id, amount),
      setQuantity(quantityKey, rawDue - 100),
      invoiceQuantity(quantityKey, amount),
    }
  }

  action init: bool = all {
    state' = {
      charged: 0,
      refunded: 0,
      refunds: REFUND_KEYS.mapBy(_ => EMPTY_REFUND),
      proration: NoProration,
      nextProrationId: 1,
      lastInvoiceId: 0,
      lastInvoiceAmount: 0,
      quantity: QUANTITY_KEYS.mapBy(_ => EMPTY_QUANTITY),
      invoiced: 0,
    },
  }

  // ── witnesses ──────────────────────────────────────────────────────────────

  val refundRecorded: bool = state.refunded > 0

  val refundPartiallyReversed: bool =
    REFUND_KEYS.exists(key => {
      val record = state.refunds.get(key)
      record.reversed > 0 and record.reversed < record.amount
    })

  val refundFullyReversed: bool =
    REFUND_KEYS.exists(key => {
      val record = state.refunds.get(key)
      record.amount > 0 and record.reversed == record.amount
    })

  val prorationOwed: bool = isOwed(state.proration)

  val prorationBilled: bool = isBilled(state.proration)

  val prorationReplaced: bool = state.nextProrationId > 2 and isOwed(state.proration)

  val quantityCreditRecorded: bool =
    QUANTITY_KEYS.exists(key => state.quantity.get(key).present and state.quantity.get(key).due < 0)

  val quantityInvoiceRecorded: bool =
    QUANTITY_KEYS.exists(key => state.quantity.get(key).invoiced)

  val quantityCreditUninvoiced: bool =
    QUANTITY_KEYS.exists(key => {
      val entry = state.quantity.get(key)
      entry.present and entry.due < 0 and not(entry.invoiced)
    })
}
