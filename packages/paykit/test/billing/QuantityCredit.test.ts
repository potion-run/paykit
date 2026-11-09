import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { allowance } from "../../src/Allowance.ts";
import { catalog } from "../../src/Catalog.ts";
import { feature } from "../../src/Feature.ts";
import { ClosePeriod } from "../../src/Subscription/ClosePeriod.command.ts";
import {
  ApplyQuantityCredit,
  QuantityCreditApplied,
  QuantityProrationNotBillable,
  RecordQuantityProrationInvoice,
} from "../../src/Subscription/QuantityProration.command.ts";
import { SetQuantity } from "../../src/Subscription/SetQuantity.command.ts";
import { type SubscribedState } from "../../src/Subscription/Subscription.state.ts";
import { tier } from "../../src/Tier.ts";
import {
  type Decision,
  decideAt,
  evolveAt,
  isAccepted,
  start,
  subscribedIn,
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

/** Mid-period: most of every seat's price is unused. */
const at = DateTime.add(start, { days: 15 });

const opened = () => subscribedIn(seatsCatalog, "team");

const changed = (
  state: SubscribedState,
  quantity: number,
  key: string,
  now: DateTime.Utc = at,
): SubscribedState =>
  subscribed(
    evolveAt(
      state,
      accepted(
        decideAt(state, new SetQuantity({ feature: "seats", quantity, dedupeKey: key }), now, key),
      ),
      now,
      key,
    ),
  );

const entryOf = (state: SubscribedState, key: string) => {
  const entry = state.quantityProrations?.[key];

  if (entry === undefined) throw new Error(`no quantity proration ${key}`);

  return entry;
};

const dueOf = (state: SubscribedState, key: string) => entryOf(state, key).proration.due;

const apply = (state: SubscribedState, prorationId: string, now: DateTime.Utc = at) =>
  decideAt(state, new ApplyQuantityCredit({ prorationId }), now, `credit-${prorationId}`);

const applied = (state: SubscribedState, prorationId: string, now: DateTime.Utc = at) =>
  subscribed(evolveAt(state, accepted(apply(state, prorationId, now)), now, "apply"));

const invoice = (state: SubscribedState, prorationId: string, amount: number) =>
  decideAt(
    state,
    new RecordQuantityProrationInvoice({
      prorationId,
      invoiceId: "in_quantity",
      amount,
      currency: "usd",
    }),
    at,
    `invoice-${prorationId}`,
  );

/** A period opened, ten seats bought, and the five billable ones given back. */
const reduced = () => {
  const ten = changed(opened(), 10, "seats:add");

  // 10 -> 3 leaves the five included seats only: the five billable seats are a
  // credit for the rest of the period.
  return changed(ten, 3, "seats:drop");
};

const creditOf = (state: SubscribedState) => -dueOf(state, "seats:drop");

describe("a quantity credit settles the next charge", () => {
  it("records the credit and applies it to the next seat change", () => {
    const state = reduced();
    const credit = entryOf(state, "seats:drop");

    // The F9 probe: a reduction is a negative due, not money to collect.
    expect(credit.proration.due).toBeLessThan(0);
    expect(credit.invoiceId).toBeUndefined();
    expect(credit.creditApplied).toBeUndefined();

    // 3 -> 6 buys one billable seat, which the credit covers exactly.
    const next = changed(state, 6, "seats:again");
    const charge = dueOf(next, "seats:again");

    expect(charge).toBeGreaterThan(0);
    expect(charge).toBeLessThan(creditOf(state));

    const decision = apply(next, "seats:again");

    expect(isAccepted(decision)).toBe(true);

    const events = accepted(decision);

    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(QuantityCreditApplied);
    expect((events[0] as InstanceType<typeof QuantityCreditApplied>).credits).toEqual([
      { prorationId: "seats:drop", amount: charge },
    ]);

    const after = applied(next, "seats:again");

    expect(dueOf(after, "seats:again")).toBe(0);
    expect(entryOf(after, "seats:again").proration.credit).toBe(charge);
    expect(entryOf(after, "seats:drop").creditApplied).toBe(charge);
    // The source stays a credit; only its remainder moved.
    expect(dueOf(after, "seats:drop")).toBe(-creditOf(state));
  });

  it("leaves a credit larger than the next charge for a later one", () => {
    const state = reduced();
    const credit = creditOf(state);

    // One billable seat: part of the credit is applied.
    const one = changed(state, 6, "seats:one");
    const first = applied(one, "seats:one");
    const firstCharge = dueOf(one, "seats:one");

    expect(dueOf(first, "seats:one")).toBe(0);
    expect(entryOf(first, "seats:one").proration.credit).toBe(firstCharge);
    expect(entryOf(first, "seats:drop").creditApplied).toBe(firstCharge);

    // Three billable seats: more of the credit goes, if any is left.
    const three = changed(first, 9, "seats:three");
    const second = applied(three, "seats:three");
    const secondCharge = dueOf(three, "seats:three");
    const afterSecond = firstCharge + Math.min(secondCharge, credit - firstCharge);

    expect(entryOf(second, "seats:three").proration.credit).toBe(
      Math.min(secondCharge, credit - firstCharge),
    );
    expect(entryOf(second, "seats:drop").creditApplied).toBe(afterSecond);

    // Two billable seats: the remainder, and only the remainder, is applied.
    const five = changed(second, 11, "seats:five");
    const third = applied(five, "seats:five");
    const thirdCharge = dueOf(five, "seats:five");
    const remainder = credit - afterSecond;

    expect(remainder).toBeGreaterThan(0);
    expect(entryOf(third, "seats:five").proration.credit).toBe(remainder);
    expect(dueOf(third, "seats:five")).toBe(thirdCharge - remainder);
    expect(entryOf(third, "seats:drop").creditApplied).toBe(credit);

    // The charge now bills its net and folds only that into `charged`.
    const net = dueOf(third, "seats:five");

    const invoiced = subscribed(
      evolveAt(third, accepted(invoice(third, "seats:five", net)), at, "invoice"),
    );

    expect(invoiced.quantityProrations?.["seats:five"]?.invoiceId).toBe("in_quantity");
    expect(invoiced.charged).toEqual({ usd: net });
  });

  it("applies a credit once, however often the command is replayed", () => {
    const state = applied(changed(reduced(), 6, "seats:again"), "seats:again");
    const charge = entryOf(state, "seats:again").proration.credit ?? 0;

    expect(charge).toBeGreaterThan(0);
    expect(entryOf(state, "seats:drop").creditApplied).toBe(charge);

    // A replay finds the charge settled and records nothing.
    expect(apply(state, "seats:again")).toEqual([]);
    expect(entryOf(state, "seats:drop").creditApplied).toBe(charge);
  });

  it("never applies a credit to itself or pays one out", () => {
    const state = reduced();
    const credit = entryOf(state, "seats:drop");

    // The source is not a charge to settle.
    const self = apply(state, "seats:drop");

    expect(isAccepted(self)).toBe(false);
    expect((self as { _tag: string })._tag).toBe("QuantityProrationNotBillable");
    expect((self as InstanceType<typeof QuantityProrationNotBillable>).due).toBe(
      credit.proration.due,
    );

    // And the invoice path still refuses the credit itself.
    expect(isAccepted(invoice(state, "seats:drop", Math.abs(credit.proration.due)))).toBe(false);
  });

  it("keeps an unapplied credit across a period close", () => {
    const state = reduced();
    const credit = creditOf(state);
    const end = state.period.end;
    const close = decideAt(state, new ClosePeriod({ periodEnd: end }), end, "close");

    expect(isAccepted(close)).toBe(true);

    const closed = subscribed(evolveAt(state, accepted(close), end, "close"));

    // A close has no quantity charge to settle, so the credit survives whole.
    expect(dueOf(closed, "seats:drop")).toBe(-credit);
    expect(entryOf(closed, "seats:drop").creditApplied).toBeUndefined();

    // The next period's first change spends it, exactly as before the close.
    const nextAt = DateTime.add(end, { days: 5 });
    const next = changed(closed, 6, "seats:next-period", nextAt);
    const after = applied(next, "seats:next-period", nextAt);

    expect(dueOf(after, "seats:next-period")).toBe(0);
    expect(entryOf(after, "seats:drop").creditApplied).toBeGreaterThan(0);
  });
});
