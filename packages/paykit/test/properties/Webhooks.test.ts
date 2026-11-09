import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import {
  StandingPhaseTag,
  standingPhaseOf,
  standingPhaseTagOfStatus,
} from "../../src/Subscription/StandingPhase.ts";
import {
  SubscriptionStatus,
  initialSubscriptionState,
  type SubscriptionState,
} from "../../src/Subscription/Subscription.state.ts";
import {
  WEBHOOK_PHASES,
  WEBHOOK_TRANSITIONS,
  WebhookAction,
  WebhookKind,
  webhookActionOf,
} from "../../src/Webhooks.ts";
import { assertProperty } from "../support/Property.ts";
import { start, subscribedAt } from "./Arbitraries.ts";

const phaseOf = (state: SubscriptionState): StandingPhaseTag => standingPhaseOf(state, start)._tag;

/** A state at one generation: the empty one, or a standing with `status`. */
const stateIn = (subscribed: boolean, status: SubscriptionStatus): SubscriptionState =>
  subscribed ? { ...subscribedAt("pro"), status } : initialSubscriptionState;

/**
 * What each delivery can mean, whatever phase it finds. A checkout activates or
 * is a replay; a succeeded payment activates, recovers or is a replay; a
 * failure fails or is ignored; a cancellation cancels or is ignored.
 */
const MEANING: Record<WebhookKind, ReadonlyArray<WebhookAction>> = {
  checkout_completed: ["activated", "ignored"],
  payment_succeeded: ["activated", "recovered", "ignored"],
  payment_failed: ["failed", "ignored"],
  subscription_canceled: ["canceled", "ignored"],
};

const Triage = Schema.Struct({
  kind: WebhookKind,
  subscribed: Schema.Boolean,
  status: SubscriptionStatus,
});

describe("the webhook action table", () => {
  it("answers every kind in every phase, and never names a purchase", () => {
    for (const kind of WebhookKind.literals) {
      for (const phase of StandingPhaseTag.literals) {
        const action = WEBHOOK_TRANSITIONS[kind][phase];
        expect(WebhookAction.literals).toContain(action);
        // A one-off pack is handled before the table, in every phase. The
        // table classifies standings, so it must not claim a purchase.
        expect(action).not.toBe("purchased");
      }
    }
  });

  it("keeps each kind to the actions it can mean", () => {
    for (const kind of WebhookKind.literals) {
      for (const phase of StandingPhaseTag.literals) {
        expect(MEANING[kind]).toContain(WEBHOOK_TRANSITIONS[kind][phase]);
      }
    }
  });

  it("names every phase a standing can be in", () => {
    expect([...WEBHOOK_PHASES].sort()).toEqual([...StandingPhaseTag.literals].sort());
  });

  it("ignores a failure or a cancellation that arrives before the standing", () => {
    // The edge never invents an order across facts: a hook that arrives first
    // is ignored rather than buffered, because the provider's retry is the
    // recovery.
    expect(WEBHOOK_TRANSITIONS.payment_failed.Unsubscribed).toBe("ignored");
    expect(WEBHOOK_TRANSITIONS.subscription_canceled.Unsubscribed).toBe("ignored");
  });

  it("never fails or cancels a standing that already ended", () => {
    for (const phase of ["Expired", "Canceled"] as const) {
      expect(WEBHOOK_TRANSITIONS.payment_failed[phase]).toBe("ignored");
      expect(WEBHOOK_TRANSITIONS.subscription_canceled[phase]).toBe("ignored");
      expect(WEBHOOK_TRANSITIONS.checkout_completed[phase]).toBe("activated");
    }
  });

  it.effect("classifies by the phase the state is in, not by the state's shape", () =>
    assertProperty(Arbitrary.schema(Triage), ({ kind, subscribed, status }) => {
      const state = stateIn(subscribed, status);
      const phase = phaseOf(state);

      // The classifier and the phase table are two views of the same state;
      // they must agree for every status, not only the ones a fixture names.
      if (phase !== (subscribed ? standingPhaseTagOfStatus(status) : "Unsubscribed")) return false;

      return webhookActionOf(kind, state) === WEBHOOK_TRANSITIONS[kind][phase];
    }),
  );
});
