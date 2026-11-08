import { HoldStatus } from "./Subscription.state.ts";

/** The moves a hold command can name. */
export const HOLD_TRANSITIONS = ["hold", "settle", "release", "expire", "none"] as const;

export type HoldTransition = (typeof HOLD_TRANSITIONS)[number];

/**
 * Where a hold goes from every status under every move. The closed statuses
 * are absorbing: a release after a settle, or a settle after a sweep, stays
 * where it is. The shape is the same total table as the standing's:
 * `[status][move]`, never `undefined`.
 *
 * @primitive
 */
export const HOLD_STATUS_TRANSITIONS: Record<HoldStatus, Record<HoldTransition, HoldStatus>> = {
  open: {
    hold: "open",
    settle: "settled",
    release: "released",
    expire: "expired",
    none: "open",
  },
  settled: {
    hold: "settled",
    settle: "settled",
    release: "settled",
    expire: "settled",
    none: "settled",
  },
  released: {
    hold: "released",
    settle: "released",
    release: "released",
    expire: "released",
    none: "released",
  },
  expired: {
    hold: "expired",
    settle: "expired",
    release: "expired",
    expire: "expired",
    none: "expired",
  },
};

/**
 * The status one move leaves behind. Total in both arguments, so a caller
 * never has to handle `undefined` for a command that found a closed hold.
 *
 * ### Asking the hold table
 * **Example:** A sweep and a settle from `open`
 * ```typescript
 * nextHoldStatus("open", "expire"); // "expired"
 * nextHoldStatus("open", "settle"); // "settled"
 * ```
 *
 * @primitive
 */
export const nextHoldStatus = (status: HoldStatus, transition: HoldTransition): HoldStatus =>
  HOLD_STATUS_TRANSITIONS[status][transition];

/** The move a hold command names. Everything else is `none`. */
export const holdTransitionOf = (command: { readonly _tag: string }): HoldTransition => {
  switch (command._tag) {
    case "Hold":
      return "hold";
    case "SettleHold":
      return "settle";
    case "ReleaseHold":
      return "release";
    case "HoldElapsed":
      return "expire";
    default:
      return "none";
  }
};
