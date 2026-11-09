import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { allowance } from "../../src/Allowance.ts";
import { catalog, planTermsOf } from "../../src/Catalog.ts";
import { feature } from "../../src/Feature.ts";
import { ChangeTier } from "../../src/Subscription/ChangeTier.command.ts";
import {
  QuantityProrationInvoiced,
  QuantityProrationMismatch,
  QuantityProrationNotBillable,
  RecordQuantityProrationInvoice,
} from "../../src/Subscription/QuantityProration.command.ts";
import {
  ProrationInvoiced,
  ProrationInvoiceMismatch,
  RecordProrationInvoice,
} from "../../src/Subscription/RecordProrationInvoice.command.ts";
import {
  QuantityProrationAlreadyBilled,
  SetQuantity,
} from "../../src/Subscription/SetQuantity.command.ts";
import { chargedOf, type SubscribedState } from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";
import {
  type Decision,
  type TierName,
  decideAt,
  evolveAt,
  isAccepted,
  prorationFor,
  start,
  subscribedIn,
  testCatalog,
} from "../properties/Arbitraries.ts";

const accepted = (decision: Decision): ReadonlyArray<{ readonly _tag: string }> => {
  if (!isAccepted(decision)) {
    throw new Error(`expected an accepted decision, got ${decision._tag}`);
  }

  return decision;
};

const subscribed = (state: ReturnType<typeof evolveAt>): SubscribedState => {
  if (state._tag !== "Subscribed") throw new Error("expected a subscribed standing");

  return state;
};

const seats = feature({ id: "seats", name: "Seats", kind: "non_consumable" });

const team = tier({
  id: "team",
  price: { amount: 1_900, currency: "usd", interval: "month" },
  grants: [
    allowance(seats, {
      included: 5,
      overage: "bill",
      pricing: { kind: "unit", amount: 1_000, currency: "usd" },
      cap: 20,
    }),
  ],
});

const seatsCatalog = Effect.runSync(catalog({ features: [seats], tiers: [team] }));
const at = DateTime.add(start, { days: 15 });

const changeTo = (state: SubscribedState, tierId: TierName, now: DateTime.Utc) => {
  const terms = planTermsOf(testCatalog, tierId);

  if (terms === null) throw new Error(`the fixture catalog has no ${tierId}`);

  return decideAt(
    state,
    new ChangeTier({
      tier: tierId,
      ...terms,
      proration: prorationFor(state, tierId, now),
    }),
    now,
    `change-${tierId}`,
  );
};

/** A pro standing that moved to scale and then to unlimited, owing two changes. */
const movedTwice = () => {
  const pro = subscribedIn(testCatalog, "pro");
  const scale = subscribed(evolveAt(pro, accepted(changeTo(pro, "scale", start)), start, "scale"));

  const unlimited = subscribed(
    evolveAt(scale, accepted(changeTo(scale, "unlimited", start)), start, "unlimited"),
  );

  return { pro, scale, unlimited };
};

describe("a tier proration invoice names the change it settles", () => {
  it("refuses an invoice opened for a change a later tier move replaced", () => {
    const { scale, unlimited } = movedTwice();

    expect(scale.proration).toEqual({ currency: "usd", credit: 1_900, charge: 9_900, due: 8_000 });
    expect(unlimited.proration).toEqual({
      currency: "usd",
      credit: 9_900,
      charge: 19_900,
      due: 10_000,
    });
    expect(scale.prorationId).toBe("1");
    expect(unlimited.prorationId).toBe("2");

    // The invoice the first change was opened for arrives after the second
    // change replaced it. It must not mark the new change billed.
    const stale = decideAt(
      unlimited,
      new RecordProrationInvoice({
        prorationId: "1",
        invoiceId: "in_old",
        amount: 8_000,
        currency: "usd",
      }),
      start,
      "old-invoice",
    );

    expect(isAccepted(stale)).toBe(false);

    const refusal = stale as InstanceType<typeof ProrationInvoiceMismatch>;

    expect(refusal._tag).toBe("ProrationInvoiceMismatch");
    expect(refusal.expectedId).toBe("2");
    expect(refusal.expected.due).toBe(10_000);
    expect(refusal.requestedId).toBe("1");
    expect(refusal.requestedAmount).toBe(8_000);
  });

  it("refuses an amount or currency the change did not move", () => {
    const { unlimited } = movedTwice();

    const wrongAmount = decideAt(
      unlimited,
      new RecordProrationInvoice({
        prorationId: "2",
        invoiceId: "in_arbitrary",
        amount: 999_999,
        currency: "usd",
      }),
      start,
      "arbitrary-amount",
    );

    expect(isAccepted(wrongAmount)).toBe(false);
    expect((wrongAmount as { _tag: string })._tag).toBe("ProrationInvoiceMismatch");

    const wrongCurrency = decideAt(
      unlimited,
      new RecordProrationInvoice({
        prorationId: "2",
        invoiceId: "in_arbitrary",
        amount: 10_000,
        currency: "eur",
      }),
      start,
      "arbitrary-currency",
    );

    expect(isAccepted(wrongCurrency)).toBe(false);
    expect((wrongCurrency as { _tag: string })._tag).toBe("ProrationInvoiceMismatch");
  });

  it("records the change id and folds the invoice into charged", () => {
    const { unlimited } = movedTwice();

    const invoice = decideAt(
      unlimited,
      new RecordProrationInvoice({
        prorationId: "2",
        invoiceId: "in_new",
        amount: 10_000,
        currency: "usd",
      }),
      start,
      "invoice",
    );

    expect(isAccepted(invoice)).toBe(true);

    const events = accepted(invoice);

    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(ProrationInvoiced);
    expect((events[0] as InstanceType<typeof ProrationInvoiced>).prorationId).toBe("2");

    const invoiced = subscribed(evolveAt(unlimited, events, start, "invoice"));

    expect(invoiced.prorationInvoice).toBe("in_new");
    expect(chargedOf(invoiced)).toEqual({ usd: 10_000 });

    const replay = decideAt(
      invoiced,
      new RecordProrationInvoice({
        prorationId: "2",
        invoiceId: "in_again",
        amount: 10_000,
        currency: "usd",
      }),
      start,
      "invoice-again",
    );

    expect(isAccepted(replay)).toBe(false);
    expect((replay as { _tag: string; reason?: string }).reason).toBe("billed");
  });
});

describe("a quantity proration invoice settles exactly its change", () => {
  const opened = () => subscribedIn(seatsCatalog, "team");

  const setQuantity = (state: SubscribedState, quantity: number, key: string) =>
    decideAt(state, new SetQuantity({ feature: "seats", quantity, dedupeKey: key }), at, key);

  const changed = (state: SubscribedState, quantity: number, key: string) =>
    subscribed(evolveAt(state, accepted(setQuantity(state, quantity, key)), at, key));

  const entryOf = (state: SubscribedState, key: string) => {
    const entry = state.quantityProrations?.[key];

    if (entry === undefined) throw new Error(`no quantity proration ${key}`);

    return entry;
  };

  it("refuses an invoice for an amount or currency the change did not move", () => {
    const state = changed(opened(), 10, "seats:add");
    const entry = entryOf(state, "seats:add");

    const wrongAmount = decideAt(
      state,
      new RecordQuantityProrationInvoice({
        prorationId: "seats:add",
        invoiceId: "in_quantity",
        amount: entry.proration.due + 1,
        currency: entry.proration.currency,
      }),
      at,
      "invoice-wrong-amount",
    );

    expect(isAccepted(wrongAmount)).toBe(false);
    expect((wrongAmount as { _tag: string })._tag).toBe("QuantityProrationMismatch");

    const wrongCurrency = decideAt(
      state,
      new RecordQuantityProrationInvoice({
        prorationId: "seats:add",
        invoiceId: "in_quantity",
        amount: entry.proration.due,
        currency: "eur",
      }),
      at,
      "invoice-wrong-currency",
    );

    expect(isAccepted(wrongCurrency)).toBe(false);

    const refusal = wrongCurrency as InstanceType<typeof QuantityProrationMismatch>;

    expect(refusal._tag).toBe("QuantityProrationMismatch");
    expect(refusal.expected.due).toBe(entry.proration.due);
  });

  it("records the invoice in charged, exactly as a tier invoice does", () => {
    const state = changed(opened(), 10, "seats:add");
    const entry = entryOf(state, "seats:add");

    expect(entry.proration.due).toBeGreaterThan(0);

    const invoice = decideAt(
      state,
      new RecordQuantityProrationInvoice({
        prorationId: "seats:add",
        invoiceId: "in_quantity",
        amount: entry.proration.due,
        currency: entry.proration.currency,
      }),
      at,
      "invoice",
    );

    expect(isAccepted(invoice)).toBe(true);

    const events = accepted(invoice);

    expect(events[0]).toBeInstanceOf(QuantityProrationInvoiced);

    const invoiced = subscribed(evolveAt(state, events, at, "invoice"));

    expect(invoiced.quantityProrations?.["seats:add"]?.invoiceId).toBe("in_quantity");
    expect(chargedOf(invoiced)).toEqual({ usd: entry.proration.due });
  });

  it("never invoices a credit", () => {
    const raised = changed(opened(), 10, "seats:add");
    const reduced = changed(raised, 3, "seats:drop");
    const entry = entryOf(reduced, "seats:drop");

    expect(entry.proration.due).toBeLessThan(0);

    for (const amount of [entry.proration.due, Math.abs(entry.proration.due)]) {
      const invoice = decideAt(
        reduced,
        new RecordQuantityProrationInvoice({
          prorationId: "seats:drop",
          invoiceId: "in_credit",
          amount,
          currency: entry.proration.currency,
        }),
        at,
        "invoice-credit",
      );

      expect(isAccepted(invoice)).toBe(false);

      const refusal = invoice as InstanceType<typeof QuantityProrationNotBillable>;

      expect(refusal._tag).toBe("QuantityProrationNotBillable");
      expect(refusal.due).toBe(entry.proration.due);
    }
  });

  it("refuses a reused key instead of replacing a change that was billed", () => {
    const raised = changed(opened(), 10, "seats:key");
    const entry = entryOf(raised, "seats:key");

    const invoiced = subscribed(
      evolveAt(
        raised,
        accepted(
          decideAt(
            raised,
            new RecordQuantityProrationInvoice({
              prorationId: "seats:key",
              invoiceId: "in_first",
              amount: entry.proration.due,
              currency: entry.proration.currency,
            }),
            at,
            "invoice",
          ),
        ),
        at,
        "invoice",
      ),
    );

    expect(invoiced.quantityProrations?.["seats:key"]?.invoiceId).toBe("in_first");

    // The same quantity is a retry and records nothing.
    expect(setQuantity(invoiced, 10, "seats:key")).toEqual([]);

    // A different quantity under the same key would replace the billed change
    // and open a second invoice. It is refused, and the first one is intact.
    const reuse = setQuantity(invoiced, 5, "seats:key");

    expect(isAccepted(reuse)).toBe(false);

    const refusal = reuse as InstanceType<typeof QuantityProrationAlreadyBilled>;

    expect(refusal._tag).toBe("QuantityProrationAlreadyBilled");
    expect(refusal.prorationId).toBe("seats:key");
    expect(refusal.invoiceId).toBe("in_first");
    expect(refusal.due).toBe(entry.proration.due);

    expect(invoiced.quantityProrations?.["seats:key"]?.invoiceId).toBe("in_first");
    expect(chargedOf(invoiced)).toEqual({ usd: entry.proration.due });
  });
});
