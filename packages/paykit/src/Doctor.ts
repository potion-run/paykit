import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { BillingReadRow } from "./BillingReadStore.ts";
import type { SqlEventLog } from "./Store/SqlEventLog.ts";
import {
  Entitlements,
  initialEntitlements,
  type EntitlementsState,
} from "./Subscription/Entitlements.view.ts";
import { Subscription } from "./Subscription/Subscription.aggregate.ts";

/** One account whose read model disagrees with the event log. */
export interface DoctorMismatch {
  readonly account: string;
  readonly stored: BillingReadRow | null;
  readonly rebuilt: BillingReadRow;
  /** The command ids (provider event ids) that produced this account's events. */
  readonly commandIds: ReadonlyArray<string>;
}

/**
 * Rebuild every read model from `billing_event` and diff it. A mismatch is a
 * read model that became a source of truth, or a projection that drifted.
 *
 * The log is read asynchronously, so this is an `Effect`: a doctor that cannot
 * reach the database is a diagnostic that cannot run.
 *
 * @primitive
 */
export const doctor = (log: SqlEventLog) =>
  Effect.gen(function* () {
    const accounts = new Set([
      ...(yield* log.accounts("Subscription")),
      ...(yield* log.readModelList()).map((row) => row.account),
    ]);
    const mismatches: Array<DoctorMismatch> = [];
    for (const account of accounts) {
      const rows = yield* log.events("Subscription", account);
      let state: EntitlementsState = initialEntitlements;
      const commandIds: Array<string> = [];
      for (const row of rows) {
        commandIds.push(row.commandId);
        const event = decodeEvent(row.event);
        if (event === null) continue;
        const handler = (
          Entitlements.definition.evolve as unknown as Record<
            string,
            (state: EntitlementsState, event: unknown, context: unknown) => EntitlementsState
          >
        )[event._tag];
        if (handler === undefined) continue;
        state = handler(state, event, {
          key: Subscription.ref(account),
          source: Subscription.ref(account),
          state: undefined,
          envelope: {
            id: account,
            stream: `Subscription/${account}`,
            seq: row.seq,
            at: dateTimeFrom(row.at),
            commandId: row.commandId,
            correlationId: row.commandId,
          },
          at: dateTimeFrom(row.at),
        });
      }
      const rebuilt = rowFromState(account, state);
      const stored = yield* log.readModel(account);
      if (!sameRow(stored, rebuilt)) {
        mismatches.push({ account, stored, rebuilt, commandIds });
      }
    }
    return mismatches;
  });

const echo = (event: { readonly _tag: string }) => event;
const decodeEvent = (json: string): { readonly _tag: string } | null => {
  const raw = JSON.parse(json) as { readonly _tag?: string };
  const cls = Subscription.definition.events.find((event) => event.tag === raw._tag);
  if (cls === undefined) return null;
  const codec = Schema.toCodecJson(cls as never);
  return echo(Schema.decodeUnknownSync(codec as never)(raw) as { readonly _tag: string });
};

const rowFromState = (account: string, state: EntitlementsState): BillingReadRow => ({
  account,
  tier: state.tier,
  status: state.status,
  standing: state.standing,
  periodStart: state.periodStart,
  periodEnd: state.periodEnd,
  cancelAtPeriodEnd: state.cancelAtPeriodEnd,
  dunningAttempts: state.dunningAttempts,
  credits: state.credits,
  ...(state.currency === undefined ? {} : { currency: state.currency }),
  features: state.features,
});

const sameRow = (stored: BillingReadRow | null, rebuilt: BillingReadRow): boolean => {
  if (stored === null) return false;
  return (
    stored.account === rebuilt.account &&
    stored.tier === rebuilt.tier &&
    stored.status === rebuilt.status &&
    stored.standing === rebuilt.standing &&
    stored.periodStart.epochMilliseconds === rebuilt.periodStart.epochMilliseconds &&
    stored.periodEnd.epochMilliseconds === rebuilt.periodEnd.epochMilliseconds &&
    stored.cancelAtPeriodEnd === rebuilt.cancelAtPeriodEnd &&
    stored.credits === rebuilt.credits &&
    stored.currency === rebuilt.currency &&
    JSON.stringify(stored.features) === JSON.stringify(rebuilt.features)
  );
};

const dateTimeFrom = (millis: number): DateTime.Utc => DateTime.makeUnsafe(millis);
