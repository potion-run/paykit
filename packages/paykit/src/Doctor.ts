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

/** One account whose read model disagrees with the event log. */ export interface DoctorMismatch {
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
    const evolveHandlers: Readonly<Record<string, unknown>> = Entitlements.definition.evolve ?? {};

    for (const account of accounts) {
      const rows = yield* log.events("Subscription", account);
      let state: EntitlementsState = initialEntitlements;
      const commandIds: Array<string> = [];

      for (const row of rows) {
        commandIds.push(row.commandId);
        const event = yield* decodeEvent(row.event);

        if (event === null) continue;

        // SAFETY: `event` was decoded by the definition whose `evolve` map is
        // keyed by the same tag, so the handler's event parameter is the
        // variant `event` decoded to.
        const handler = evolveHandlers[event._tag] as
          | ((state: EntitlementsState, event: unknown, context: unknown) => EntitlementsState)
          | undefined;

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

/** A stored event, parsed but not yet decoded: the tag picks the codec. */
const StoredEvent = Schema.fromJsonString(Schema.Unknown);

/**
 * Decode one stored event by its tag, as an `Effect`. The whole payload is
 * kept for the second decode — a `Struct` here would strip the fields the
 * event's own codec needs. An event the current schema cannot read fails the
 * doctor rather than vanishing from the rebuild: a doctor that silently skips
 * a corrupt event reports a mismatch it invented.
 */
const decodeEvent = (
  json: string,
): Effect.Effect<{ readonly _tag: string } | null, Schema.SchemaError> =>
  Effect.gen(function* () {
    const raw = yield* Schema.decodeEffect(StoredEvent)(json);

    if (typeof raw !== "object" || raw === null) return null;
    // SAFETY: the value is a decoded event, or a JSON value this diagnostic walks.
    const tag = (raw as { readonly _tag?: unknown })._tag;

    if (typeof tag !== "string") return null;
    const cls = Subscription.definition.events.find((event) => event.tag === tag);

    if (cls === undefined) return null;
    // SAFETY: the value is a decoded event, or a JSON value this diagnostic walks.
    const codec = Schema.toCodecJson(cls as never) as Schema.ConstraintDecoder<unknown>;

    // `toCodecJson` decodes the JSON wire form, which is what the parse above
    // handed back: `decodeEffect` is the decoder for exactly that input.
    // SAFETY: the value is a decoded event, or a JSON value this diagnostic walks.
    return (yield* Schema.decodeEffect(codec)(raw)) as { readonly _tag: string };
  });

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
  prepaidCredits: state.prepaidCredits ?? 0,
  ...(state.currency === undefined ? {} : { currency: state.currency }),
  features: state.features,
  ...(state.entities === undefined || Object.keys(state.entities).length === 0
    ? {}
    : { entities: state.entities }),
});

/**
 * JSON with object keys sorted. `doctor` compares a rebuild to a stored row,
 * and a rebuild that assembles a feature's fields in a different order than the
 * row a previous rebuild wrote is not a drift: the two agree on every value.
 * Comparing the text `JSON.stringify` produces would report one.
 */
const canonicalJson = (value: unknown): string => {
  if (value === undefined) return "null";

  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  if (value !== null && typeof value === "object") {
    // SAFETY: the value is a decoded event, or a JSON value this diagnostic walks.
    const entries = Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
};

const sameRow = (stored: BillingReadRow | null, rebuilt: BillingReadRow): boolean =>
  stored !== null && canonicalJson(stored) === canonicalJson(rebuilt);

const dateTimeFrom = (millis: number): DateTime.Utc => DateTime.makeUnsafe(millis);
