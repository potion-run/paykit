import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { isFlagGrant } from "../../src/Allowance.ts";
import { evaluateCheck } from "../../src/Check.ts";
import {
  BillingState,
  initialBillingState,
  type BillingStateView,
} from "../../src/Subscription/BillingState.view.ts";
import {
  Entitlements,
  initialEntitlements,
  type EntitlementsState,
} from "../../src/Subscription/Entitlements.view.ts";
import { Hold } from "../../src/Subscription/Hold.command.ts";
import {
  initialSubscriptionState,
  remainingOf,
  reservedCreditsOf,
  reservedOf,
  standingOf,
  usedOf,
  type SubscriptionState,
} from "../../src/Subscription/Subscription.state.ts";
import { TrackUsage } from "../../src/Subscription/TrackUsage.command.ts";
import { assertProperty } from "../support/Property.ts";
import {
  commandOf,
  decideAt,
  evolveAt,
  isAccepted,
  propertyAccount,
  Script,
  start,
} from "./Arbitraries.ts";

type Event = Readonly<{ readonly _tag: string }>;

const handlers = Entitlements.definition.evolve as unknown as Record<
  string,
  (state: EntitlementsState, event: Event, context: unknown) => EntitlementsState
>;

const billingHandlers = BillingState.definition.evolve as unknown as Record<
  string,
  (state: BillingStateView, event: Event, context: unknown) => BillingStateView
>;

/** Fold one accepted decision into the view the read path answers from. */
const foldView = (view: EntitlementsState, events: ReadonlyArray<Event>): EntitlementsState =>
  events.reduce<EntitlementsState>((current, event) => {
    const handler = handlers[event._tag];
    return handler === undefined
      ? current
      : handler(current, event, { key: { id: propertyAccount } });
  }, view);

const foldBilling = (view: BillingStateView, events: ReadonlyArray<Event>): BillingStateView =>
  events.reduce<BillingStateView>((current, event) => {
    const handler = billingHandlers[event._tag];
    return handler === undefined
      ? current
      : handler(current, event, { key: { id: propertyAccount } });
  }, view);

const sameDate = (left: DateTime.Utc | undefined, right: DateTime.Utc | undefined): boolean =>
  left === undefined || right === undefined
    ? left === right
    : DateTime.toEpochMillis(left) === DateTime.toEpochMillis(right);

/**
 * The billing page is the same log folded again, and must report the same
 * tier, standing, money and dunning count. A page that trails the state is a
 * support ticket waiting to happen.
 */
const billingMatchesState = (state: SubscriptionState, view: BillingStateView): boolean => {
  if (state._tag !== "Subscribed") return true;
  if (view.account !== propertyAccount) return false;
  if (view.tier !== state.tier) return false;
  if (view.status !== state.status) return false;
  if (view.credits !== state.credits) return false;
  if (view.cancelAtPeriodEnd !== state.cancelAtPeriodEnd) return false;
  if (view.dunningAttempts !== state.dunningAttempts) return false;
  if (view.interval !== state.interval) return false;
  if (view.anchorTz !== state.period.anchorTz) return false;
  if (DateTime.toEpochMillis(view.periodStart) !== DateTime.toEpochMillis(state.period.start)) {
    return false;
  }
  if (DateTime.toEpochMillis(view.periodEnd) !== DateTime.toEpochMillis(state.period.end)) {
    return false;
  }
  if (view.currency !== state.currency) return false;
  if (!sameDate(view.trialEndsAt, state.trialEndsAt)) return false;
  if (!sameDate(view.graceUntil, state.graceUntil)) return false;
  if (JSON.stringify(view.price) !== JSON.stringify(state.price)) return false;
  if (JSON.stringify(view.proration) !== JSON.stringify(state.proration)) return false;
  return view.prorationInvoice === state.prorationInvoice;
};

const Probe = Schema.Struct({
  /** `sso` is a feature no tier grants, so a read and a write must both say no. */
  feature: Schema.Literals(["messages", "ai", "sso"]),
  amount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50_000 }))),
  dimension: Schema.optionalKey(Schema.Literals(["default", "gpt-large"])),
});
type Probe = typeof Probe.Type;

const Case = Schema.Struct({ script: Script, probe: Probe });

const inputOf = (probe: Probe) => ({
  account: propertyAccount,
  feature: probe.feature,
  amount: probe.amount,
  ...(probe.feature === "ai" && probe.dimension !== undefined
    ? { dimension: probe.dimension }
    : {}),
});

/**
 * The view is a second fold of the same events. It must report the state the
 * aggregate holds, feature by feature: a `check()` that reads a stale `used` or
 * `reserved` is as wrong as a wrong `decide`.
 */
const viewMatchesState = (state: SubscriptionState, view: EntitlementsState): boolean => {
  if (state._tag !== "Subscribed") return true;
  if (view.tier !== state.tier) return false;
  if (view.status !== state.status) return false;
  if (view.standing !== standingOf(state.status)) return false;
  if (view.credits !== state.credits) return false;
  if (view.cancelAtPeriodEnd !== state.cancelAtPeriodEnd) return false;
  if (view.dunningAttempts !== state.dunningAttempts) return false;
  if (DateTime.toEpochMillis(view.periodStart) !== DateTime.toEpochMillis(state.period.start)) {
    return false;
  }
  if (DateTime.toEpochMillis(view.periodEnd) !== DateTime.toEpochMillis(state.period.end)) {
    return false;
  }

  for (const [feature, allowance] of Object.entries(state.allowances)) {
    const entry = view.features[feature];
    if (entry === undefined) return false;
    if (entry.used !== usedOf(state, feature)) return false;
    if (entry.reserved !== reservedOf(state, feature)) return false;
    if (isFlagGrant(allowance)) {
      if (entry.remaining !== null) return false;
    } else if (entry.remaining !== remainingOf(state, feature)) return false;
  }

  // A credit-priced feature shares one pool: its `remaining` is the pool less
  // every open hold, and its `reserved` is those holds' credits, not units.
  const heldCredits = reservedCreditsOf(state);
  for (const feature of Object.keys(state.rates)) {
    const entry = view.features[feature];
    if (entry === undefined) return false;
    if (entry.used !== usedOf(state, feature)) return false;
    if (entry.reserved !== heldCredits) return false;
    if (entry.remaining !== state.credits - heldCredits) return false;
  }

  return true;
};

/**
 * The read path and the write path must give one answer. `check()` is
 * advisory, but a caller that is told yes and then refused in the same
 * transaction has been lied to, and the two implementations of the same rule
 * (`evaluateCheck`/`allowsOne` and `decide`) are where that drift lives.
 *
 * A flag is the one deliberate divergence: it is granted (the read says yes)
 * and it is not counted (the write refuses to meter it), so flags are skipped.
 */
const agree = (
  state: SubscriptionState,
  view: EntitlementsState,
  probe: Probe,
  now: DateTime.Utc,
): boolean => {
  if (state._tag === "Subscribed") {
    const allowance = state.allowances[probe.feature];
    if (allowance !== undefined && isFlagGrant(allowance)) return true;
  }

  const input = inputOf(probe);
  const asked = evaluateCheck(view, input);

  const tracked = decideAt(
    state,
    new TrackUsage({
      feature: probe.feature,
      amount: probe.amount,
      ...("dimension" in input ? { dimension: input.dimension } : {}),
    }),
    now,
    "probe-track",
  );
  if (asked.allowed !== isAccepted(tracked)) return false;

  const held = decideAt(
    state,
    new Hold({
      holdId: "probe-hold",
      feature: probe.feature,
      amount: probe.amount,
      expiresAt: DateTime.add(now, { days: 1 }),
      ...("dimension" in input ? { dimension: input.dimension } : {}),
    }),
    now,
    "probe-hold",
  );
  return asked.allowed === isAccepted(held);
};

describe("read and write agreement", () => {
  it.effect("check() says yes exactly when the generated command is accepted", () =>
    assertProperty(
      Arbitrary.schema(Case),
      ({ script, probe }) => {
        let state: SubscriptionState = initialSubscriptionState;
        let view = initialEntitlements;
        let billing = initialBillingState;
        let now = start;
        if (!agree(state, view, probe, now)) return false;
        if (!viewMatchesState(state, view)) return false;
        if (!billingMatchesState(state, billing)) return false;

        for (const [index, step] of script.steps.entries()) {
          now = DateTime.add(now, { days: step.advanceDays });
          const command = commandOf(step.command, state, now);
          const decision = decideAt(state, command, now, `agreement-${index}`);
          if (!isAccepted(decision)) continue;
          state = evolveAt(state, decision, now, `agreement-${index}`);
          view = foldView(view, decision);
          billing = foldBilling(billing, decision);
          if (!viewMatchesState(state, view)) return false;
          if (!billingMatchesState(state, billing)) return false;
          if (!agree(state, view, probe, now)) return false;
        }

        return true;
      },
      { runs: 100, size: 50 },
    ),
  );
});
