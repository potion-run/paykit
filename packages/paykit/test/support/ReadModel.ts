import * as Effect from "effect/Effect";
import type { BillingReadRow, BillingReadStore } from "../../src/BillingReadStore.ts";
import type { EntitlementsState } from "../../src/Subscription/Entitlements.view.ts";

/** The port's read side, without the layer machinery. */
type RowReader = Pick<BillingReadStore["Service"], "get">;

const sameRow = (row: BillingReadRow | null, view: EntitlementsState): boolean =>
  row !== null &&
  row.tier === view.tier &&
  row.status === view.status &&
  row.standing === view.standing &&
  row.credits === view.credits &&
  JSON.stringify(row.features) === JSON.stringify(view.features);

/**
 * Wait until the projection's row says what the view says. `caughtUp` reports
 * the projection's progress, but a row it writes can still trail that report
 * under a loaded suite, so a read straight after a write races. This is a
 * bounded poll of the invariant — row equals view — rather than a sleep long
 * enough to be probably fine.
 */
export const waitForProjection = (
  store: RowReader,
  account: string,
  view: EntitlementsState | null,
): Effect.Effect<BillingReadRow | null> =>
  Effect.gen(function* () {
    if (view === null) return null;
    let row = yield* store.get(account);
    for (let attempt = 0; attempt < 500 && !sameRow(row, view); attempt++) {
      yield* Effect.sleep("10 millis");
      row = yield* store.get(account);
    }
    return row;
  });
