import { describe, expect, it } from "@alchemy.run/test";
import {
  HOLD_STATUS_TRANSITIONS,
  HOLD_TRANSITIONS,
  holdTransitionOf,
  nextHoldStatus,
} from "../../src/Subscription/HoldPhase.ts";
import { HoldStatus } from "../../src/Subscription/Subscription.state.ts";

describe("HOLD_STATUS_TRANSITIONS", () => {
  it("is total: every hold status answers every move", () => {
    for (const status of HoldStatus.literals) {
      for (const transition of HOLD_TRANSITIONS) {
        expect(HoldStatus.literals).toContain(HOLD_STATUS_TRANSITIONS[status][transition]);
      }
    }
  });

  it("moves an open hold to a closed status, and keeps a closed one closed", () => {
    expect(nextHoldStatus("open", "settle")).toBe("settled");
    expect(nextHoldStatus("open", "release")).toBe("released");
    expect(nextHoldStatus("open", "expire")).toBe("expired");
    for (const status of ["settled", "released", "expired"] as const) {
      for (const transition of HOLD_TRANSITIONS) {
        expect(nextHoldStatus(status, transition)).toBe(status);
      }
    }
  });

  it("classifies the hold commands", () => {
    expect(holdTransitionOf({ _tag: "Hold" })).toBe("hold");
    expect(holdTransitionOf({ _tag: "SettleHold" })).toBe("settle");
    expect(holdTransitionOf({ _tag: "ReleaseHold" })).toBe("release");
    expect(holdTransitionOf({ _tag: "HoldElapsed" })).toBe("expire");
    expect(holdTransitionOf({ _tag: "TrackUsage" })).toBe("none");
  });
});
