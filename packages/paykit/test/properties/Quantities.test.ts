import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { allowance, pricingOf, type Allowance } from "../../src/Allowance.ts";
import { catalog, planTermsOf } from "../../src/Catalog.ts";
import { feature, messages } from "../../src/Feature.ts";
import { prorate, prorateQuantity } from "../../src/Proration.ts";
import { capacityOf } from "../../src/Subscription/Allowance.verdict.ts";
import { ChangeTier } from "../../src/Subscription/ChangeTier.command.ts";
import { ClosePeriod } from "../../src/Subscription/ClosePeriod.command.ts";
import { Hold } from "../../src/Subscription/Hold.command.ts";
import {
  NoQuantityProrationDue,
  RecordQuantityProrationInvoice,
} from "../../src/Subscription/QuantityProration.command.ts";
import { ScheduleTierChange } from "../../src/Subscription/ScheduleTierChange.command.ts";
import { QuantityChanged, SetQuantity } from "../../src/Subscription/SetQuantity.command.ts";
import { SetUsage, UsageSet } from "../../src/Subscription/SetUsage.command.ts";
import {
  occupiedOf,
  quantityAfterTierChange,
  quantityOf,
  type SubscribedState,
} from "../../src/Subscription/Subscription.state.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { tier } from "../../src/Tier.ts";
import { assertProperty } from "../support/Property.ts";
import {
  Amount,
  Days,
  decideAt,
  evolveAt,
  isAccepted,
  start,
  subscribedIn,
} from "./Arbitraries.ts";

const price = { amount: 1_900, currency: "usd", interval: "month" as const };
const seats = feature({ id: "seats", name: "Seats", kind: "non_consumable" });

/** A billed seat: 5 free, $10 a seat, never more than 20. */
const team = tier({
  id: "team",
  price,
  grants: [
    allowance(seats, {
      included: 5,
      overage: "bill",
      pricing: { kind: "unit", amount: 1_000, currency: "usd" },
      cap: 20,
    }),
    allowance(messages, { included: 100 }),
  ],
});

/** The same shape with a bigger free grant and cap, and a dearer seat. */
const enterprise = tier({
  id: "enterprise",
  price: { amount: 9_900, currency: "usd", interval: "month" },
  grants: [
    allowance(seats, {
      included: 10,
      overage: "bill",
      pricing: { kind: "unit", amount: 2_000, currency: "usd" },
      cap: 30,
    }),
  ],
});

/** Additional seats are refused: only the free grant exists. */
const blocked = tier({
  id: "blocked",
  price,
  grants: [allowance(seats, { included: 3, overage: "block", cap: 10 })],
});

/** The change is recorded, but the next period bills it. */
const deferred = tier({
  id: "deferred",
  price,
  grants: [
    allowance(seats, {
      included: 2,
      overage: "bill",
      pricing: { kind: "unit", amount: 2_000, currency: "usd" },
      prorate: "period_end",
      cap: 15,
    }),
  ],
});

/** Extra seats are free, so a change moves no money at all. */
const free = tier({
  id: "free",
  price,
  grants: [allowance(seats, { included: 5, overage: "allow", cap: 8 })],
});

const seatsCatalog = Effect.runSync(
  catalog({ features: [seats, messages], tiers: [team, enterprise, blocked, deferred, free] }),
);

/** A tier that grants seats and the terms a command carries for it. */
const Stock = Schema.Literals(["team", "enterprise", "blocked", "deferred", "free"]);

type Stock = typeof Stock.Type;

const Quantity = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 32 })));

const termsOf = (tier: Stock) => {
  const terms = planTermsOf(seatsCatalog, tier);

  if (terms === null) throw new Error(`the seat catalog is missing ${tier}`);

  return terms;
};

const seatsAllowance = (state: SubscribedState): Allowance => state.allowances.seats!;

const includedOf = (allowance: Allowance): number =>
  typeof allowance.included === "number" ? allowance.included : 0;

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** The tag a rejection answered, for a decision that may be events or one failure. */
const tagOf = (decision: unknown): string | undefined =>
  typeof decision === "object" && decision !== null && "_tag" in decision
    ? String((decision as { readonly _tag: unknown })._tag)
    : undefined;

const changedOf = (
  decision: ReadonlyArray<{ readonly _tag: string }>,
): InstanceType<typeof QuantityChanged> | undefined =>
  decision.find(
    (event): event is InstanceType<typeof QuantityChanged> => event._tag === "QuantityChanged",
  );

/** The proration the model says a change at `at` should record. */
const prorationFor = (
  state: SubscribedState,
  allowance: Allowance,
  quantity: number,
  at: DateTime.Utc,
) => {
  const pricing = pricingOf(allowance);

  const unitPrice =
    pricing === null || pricing._tag !== "unit"
      ? null
      : { amount: pricing.unitPrice.amount, currency: pricing.unitPrice.currency };

  if (allowance.prorate === "period_end" || unitPrice === null) return null;

  return prorateQuantity({
    from: quantityOf(state, "seats", allowance),
    to: quantity,
    included: includedOf(allowance),
    unitPrice,
    period: state.period,
    at,
  });
};

describe("a seat is a quantity that is set", () => {
  /**
   * The command carries the total, not a delta, so a retry of the same call is
   * the same quantity. The cap is the ceiling of what may be held, the free
   * grant is a price boundary rather than a spendable count, and the proration
   * is only ever the billable difference for the rest of the period.
   */
  it.effect("setting a quantity is idempotent, capped, and prorated on the billable part", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          tier: Stock,
          first: Quantity,
          second: Quantity,
          advanceDays: Days,
        }),
      ),
      ({ tier: stock, first, second, advanceDays }) => {
        const opened = subscribedIn(seatsCatalog, stock);
        const allowance = seatsAllowance(opened);
        const included = includedOf(allowance);
        const cap = allowance.cap;
        const at = DateTime.add(start, { days: advanceDays });

        const attempt = (
          state: SubscribedState,
          quantity: number,
          key: string,
        ): { readonly state: SubscribedState; readonly accepted: boolean } | false => {
          const before = quantityOf(state, "seats", allowance);

          const decision = decideAt(
            state,
            new SetQuantity({ feature: "seats", quantity, dedupeKey: key }),
            at,
            key,
          );

          const overCap = cap !== undefined && quantity > cap;
          const overBlock = allowance.overage === "block" && quantity > included;

          if (!isAccepted(decision)) {
            if (overCap) {
              if (tagOf(decision) !== "QuantityCapExceeded") return false;
            } else if (overBlock) {
              if (tagOf(decision) !== "QuantityExceeded") return false;
            } else {
              return false;
            }

            // A refusal writes nothing; the account still holds what it held.
            return { state, accepted: false };
          }

          // Setting the quantity the account already holds records nothing.
          if (decision.length === 0) {
            return before === quantity ? { state, accepted: true } : false;
          }

          if (overCap || overBlock) return false;

          const changed = changedOf(decision);

          if (changed === undefined) return false;

          if (changed.quantityBefore !== before || changed.quantityAfter !== quantity) return false;

          if (changed.proration !== undefined && changed.prorationId !== key) return false;

          const expected = prorationFor(state, allowance, quantity, at);

          if (expected === null) {
            if (changed.proration !== undefined) return false;
          } else if (!same(changed.proration, expected)) {
            return false;
          }

          if (changed.proration !== undefined) {
            const billableBefore = Math.max(0, before - included);
            const billableAfter = Math.max(0, quantity - included);
            const grew = billableAfter > billableBefore;
            const shrank = billableAfter < billableBefore;

            if (grew && changed.proration.due <= 0) return false;

            if (shrank && changed.proration.due >= 0) return false;
          }

          const next = evolveAt(state, decision, at, key);

          if (next._tag !== "Subscribed") return false;

          if (next.quantities?.seats !== quantity) return false;
          // Nothing is occupied in this script, so the balance is the purchase.

          if (next.remaining.seats !== quantity) return false;

          // Setting the quantity the account already holds records nothing.
          const replay = decideAt(
            next,
            new SetQuantity({ feature: "seats", quantity, dedupeKey: `${key}-replay` }),
            at,
            `${key}-replay`,
          );

          if (!isAccepted(replay) || replay.length !== 0) return false;

          return { state: next, accepted: true };
        };

        const firstAttempt = attempt(opened, first, "seats:first");

        if (firstAttempt === false) return false;
        const secondAttempt = attempt(firstAttempt.state, second, "seats:second");

        if (secondAttempt === false) return false;

        if (secondAttempt.accepted) return secondAttempt.state.quantities?.seats === second;

        return secondAttempt.state.quantities?.seats === firstAttempt.state.quantities?.seats;
      },
      { runs: 100, size: 30 },
    ),
  );

  it("refuses a quantity on a metered feature, and a use of a seat", () => {
    const state = subscribedIn(seatsCatalog, "team");

    const onMessages = decideAt(
      state,
      new SetQuantity({ feature: "messages", quantity: 10, dedupeKey: "messages:1" }),
      start,
      "messages",
    );

    expect(isAccepted(onMessages)).toBe(false);
    expect(tagOf(onMessages)).toBe("FeatureNotConsumable");

    const usage = decideAt(state, new TrackUsage({ feature: "seats", amount: 1 }), start, "use");
    expect(isAccepted(usage)).toBe(false);
    expect(tagOf(usage)).toBe("FeatureNotConsumable");

    const held = decideAt(
      state,
      new Hold({
        holdId: "seat-hold",
        feature: "seats",
        amount: 1,
        expiresAt: DateTime.add(start, { days: 1 }),
      }),
      start,
      "hold",
    );

    expect(isAccepted(held)).toBe(false);
    expect(tagOf(held)).toBe("FeatureNotConsumable");
  });

  /**
   * A quantity is judged by the occupancy balance, `purchased - occupied`,
   * which may be negative. The cap is the purchase ceiling and `SetQuantity`
   * enforces it; `check` only answers whether one more seat fits (ADR 0036).
   */
  it.effect("check() answers from the occupancy balance, not from the cap", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          quantity: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 30 }))),
          included: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
          occupied: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 30 }))),
          amount: Amount,
        }),
      ),
      ({ quantity, included, occupied, amount }) => {
        const remaining = quantity - occupied;

        const verdict = capacityOf({
          standing: "good",
          feature: {
            overage: "bill",
            included,
            quantity,
            billed: 0,
            used: occupied,
            reserved: 0,
            remaining,
          },
          ask: { amount },
        });

        return amount > remaining
          ? verdict._tag === "Remaining" &&
              verdict.requested === amount &&
              verdict.remaining === remaining
          : verdict._tag === "Allowed";
      },
      { runs: 100 },
    ),
  );

  /**
   * A tier change keeps what the account holds and a bigger free grant raises
   * it; a smaller grant does not take a seat away. The remaining count is the
   * new cap less the quantity the account still holds — on an immediate change
   * and on one applied at the period boundary alike.
   */
  it.effect("a change of tier keeps the quantity, or raises it to the new grant", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          startTier: Stock,
          nextTier: Stock,
          quantity: Quantity,
          advanceDays: Days,
          scheduled: Schema.Boolean,
        }),
      ),
      ({ startTier, nextTier, quantity, advanceDays, scheduled }) => {
        const opened = subscribedIn(seatsCatalog, startTier);
        const at = DateTime.add(start, { days: advanceDays });

        const set = decideAt(
          opened,
          new SetQuantity({ feature: "seats", quantity, dedupeKey: "seats:set" }),
          at,
          "seats:set",
        );

        const state = isAccepted(set) ? evolveAt(opened, set, at, "seats:set") : opened;

        if (state._tag !== "Subscribed") return false;
        const before = quantityOf(state, "seats", seatsAllowance(state));
        const target = termsOf(nextTier);

        const expectedQuantity = quantityAfterTierChange(
          before,
          includedOf(target.allowances.seats!),
        );

        // Occupancy is untouched by a plan change, and this script never sets
        // it, so the balance is the purchase.
        const remainingFor = (next: SubscribedState) =>
          quantityOf(next, "seats", seatsAllowance(next));

        if (scheduled) {
          const schedule = decideAt(
            state,
            new ScheduleTierChange({ tier: nextTier, ...target }),
            at,
            "schedule",
          );

          // A scheduled change to the tier already held records nothing.
          if (!isAccepted(schedule)) return true;
          const pending = evolveAt(state, schedule, at, "schedule");

          if (pending._tag !== "Subscribed") return false;
          const boundary = pending.period.end;

          const close = decideAt(
            pending,
            new ClosePeriod({ periodEnd: boundary }),
            boundary,
            "close",
          );

          if (!isAccepted(close)) return false;
          const next = evolveAt(pending, close, boundary, "close");

          if (next._tag !== "Subscribed") return false;

          if (next.tier !== nextTier) return false;

          if (quantityOf(next, "seats", seatsAllowance(next)) !== expectedQuantity) return false;

          if (next.remaining.seats !== remainingFor(next)) return false;

          return quantityOf(next, "seats", seatsAllowance(next)) >= before;
        }

        const proration =
          prorate({
            from: state.price,
            to: target.price,
            period: state.period,
            at,
          }) ?? undefined;

        const change = decideAt(
          state,
          new ChangeTier({
            tier: nextTier,
            ...target,
            ...(proration === undefined ? {} : { proration }),
          }),
          at,
          "change",
        );

        // A downgrade below what is held is a refusal, not a seat removal.
        if (!isAccepted(change)) {
          return tagOf(change)?.startsWith("Downgrade") === true;
        }

        const next = evolveAt(state, change, at, "change");

        if (next._tag !== "Subscribed") return false;

        if (next.tier !== nextTier) return false;

        if (quantityOf(next, "seats", seatsAllowance(next)) !== expectedQuantity) return false;

        if (next.remaining.seats !== remainingFor(next)) return false;

        return quantityOf(next, "seats", seatsAllowance(next)) >= before;
      },
      { runs: 100, size: 30 },
    ),
  );

  /**
   * The change's money is a keyed entry on the standing: an invoice records it
   * once, a retry is refused as already billed, and an id the log never saw is
   * refused as nothing due. A reduction's credit stays for the next period, so
   * it is recorded with a negative `due` rather than invoiced.
   */
  it("occupancy is its own write: purchased and occupied move independently", () => {
    const opened = subscribedIn(seatsCatalog, "team");
    const allowanceOf = seatsAllowance(opened);

    expect(quantityOf(opened, "seats", allowanceOf)).toBe(5);
    expect(occupiedOf(opened, "seats")).toBe(0);

    const set = decideAt(opened, new SetUsage({ feature: "seats", usage: 3 }), start, "use");

    expect(isAccepted(set)).toBe(true);

    if (!isAccepted(set)) throw new Error("expected an accepted usage write");

    expect(set).toHaveLength(1);
    expect(set[0]).toBeInstanceOf(UsageSet);

    const used = evolveAt(opened, set, start, "use");

    if (used._tag !== "Subscribed") throw new Error("expected a standing");

    expect(used.quantities?.seats).toBe(5);
    expect(occupiedOf(used, "seats")).toBe(3);
    expect(used.remaining.seats).toBe(2);

    // Setting the same occupancy again records nothing.
    const replay = decideAt(used, new SetUsage({ feature: "seats", usage: 3 }), start, "use-2");
    expect(isAccepted(replay)).toBe(true);
    expect(replay).toHaveLength(0);

    // Lowering the purchase below occupancy is allowed; remaining goes negative.
    const down = decideAt(
      used,
      new SetQuantity({ feature: "seats", quantity: 2, dedupeKey: "seats:down" }),
      start,
      "down",
    );

    expect(isAccepted(down)).toBe(true);

    if (!isAccepted(down)) throw new Error("expected the purchase change");

    const below = evolveAt(used, down, start, "down");

    if (below._tag !== "Subscribed") throw new Error("expected a standing");

    expect(below.quantities?.seats).toBe(2);
    expect(occupiedOf(below, "seats")).toBe(3);
    expect(below.remaining.seats).toBe(-1);

    // A seat cannot be used as metered usage, and a usage write cannot land on
    // a metered feature.
    const usageOfSeat = decideAt(
      below,
      new TrackUsage({ feature: "seats", amount: 1 }),
      start,
      "t",
    );

    expect(tagOf(usageOfSeat)).toBe("FeatureNotConsumable");

    const usageOfMessages = decideAt(
      below,
      new SetUsage({ feature: "messages", usage: 1 }),
      start,
      "m",
    );

    expect(tagOf(usageOfMessages)).toBe("FeatureNotConsumable");
  });

  it("records occupancy going away and back", () => {
    const opened = subscribedIn(seatsCatalog, "team");

    const one = decideAt(opened, new SetUsage({ feature: "seats", usage: 5 }), start, "one");

    if (!isAccepted(one)) throw new Error("expected five");
    const atFive = evolveAt(opened, one, start, "one");

    if (atFive._tag !== "Subscribed") throw new Error("expected a standing");

    const two = decideAt(atFive, new SetUsage({ feature: "seats", usage: 3 }), start, "two");
    expect(isAccepted(two)).toBe(true);

    if (!isAccepted(two)) throw new Error("expected three");
    expect(two).toHaveLength(1);
    expect(occupiedOf(atFive, "seats")).toBe(5);
  });

  it("refuses a raise on a blocked standing, and still frees a seat there", () => {
    const opened = subscribedIn(seatsCatalog, "team");
    const ended: SubscribedState = { ...opened, status: "canceled" };
    const raised = decideAt(ended, new SetUsage({ feature: "seats", usage: 1 }), start, "raise");

    expect(isAccepted(raised)).toBe(false);
    expect(tagOf(raised)).toBe("StandingBlocksUsage");

    // Freeing a seat is a cleanup a terminal standing may still do.
    const freed = decideAt(ended, new SetUsage({ feature: "seats", usage: 0 }), start, "free");
    expect(isAccepted(freed)).toBe(true);
  });

  it.effect("a quantity proration is invoiced once, and a credit is never billed", () =>
    assertProperty(
      Arbitrary.schema(
        Schema.Struct({
          tier: Stock,
          quantity: Quantity,
          next: Quantity,
          advanceDays: Days,
        }),
      ),
      ({ tier: stock, quantity, next: quantityAfter, advanceDays }) => {
        const opened = subscribedIn(seatsCatalog, stock);
        const at = DateTime.add(start, { days: advanceDays });

        const first = decideAt(
          opened,
          new SetQuantity({ feature: "seats", quantity, dedupeKey: "seats:one" }),
          at,
          "seats:one",
        );

        const state = isAccepted(first) ? evolveAt(opened, first, at, "seats:one") : opened;

        if (state._tag !== "Subscribed") return false;

        const changed = decideAt(
          state,
          new SetQuantity({ feature: "seats", quantity: quantityAfter, dedupeKey: "seats:two" }),
          at,
          "seats:two",
        );

        if (isAccepted(changed) && changed.length === 0) return true;

        if (!isAccepted(changed)) return tagOf(changed)?.startsWith("Quantity") === true;
        const nextState = evolveAt(state, changed, at, "seats:two");

        if (nextState._tag !== "Subscribed") return false;
        const entry = nextState.quantityProrations?.["seats:two"];

        if (entry === undefined) return true;

        const invoice = decideAt(
          nextState,
          new RecordQuantityProrationInvoice({
            prorationId: "seats:two",
            invoiceId: "in_quantity",
            amount: entry.proration.due,
            currency: entry.proration.currency,
          }),
          at,
          "invoice",
        );

        if (!isAccepted(invoice)) return false;
        const invoiced = evolveAt(nextState, invoice, at, "invoice");

        if (invoiced._tag !== "Subscribed") return false;

        if (invoiced.quantityProrations?.["seats:two"]?.invoiceId !== "in_quantity") return false;

        const retry = decideAt(
          invoiced,
          new RecordQuantityProrationInvoice({
            prorationId: "seats:two",
            invoiceId: "in_again",
            amount: entry.proration.due,
            currency: entry.proration.currency,
          }),
          at,
          "invoice-again",
        );

        if (isAccepted(retry)) return false;

        if (tagOf(retry) !== "NoQuantityProrationDue") return false;

        if ((retry as InstanceType<typeof NoQuantityProrationDue>).reason !== "billed")
          return false;

        const unknown = decideAt(
          nextState,
          new RecordQuantityProrationInvoice({
            prorationId: "seats:unknown",
            invoiceId: "in_unknown",
            amount: 1,
            currency: "usd",
          }),
          at,
          "invoice-unknown",
        );

        if (isAccepted(unknown)) return false;

        return (unknown as InstanceType<typeof NoQuantityProrationDue>).reason === "none";
      },
      { runs: 100, size: 30 },
    ),
  );
});
