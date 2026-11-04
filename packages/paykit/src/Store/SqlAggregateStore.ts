import {
  AlreadyExecuted,
  type Due,
  type SendMeta,
  NotScheduled,
} from "@alchemy.run/domain/Aggregate";
import type {
  AggregateKit,
  AggregateStore,
  Delivery,
  StoredEvent,
} from "@alchemy.run/domain/Platform";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { SqlEventLog } from "./SqlEventLog.ts";

/** What one aggregate's store needs beyond the log itself. */
export interface SqlAggregateStoreOptions {
  /** The aggregate's name, as the model declares it. */
  readonly aggregate: string;
  /** Epoch milliseconds, injected so the store has no ambient clock. */
  readonly now: () => number;
  /** How often a live read polls the log for a commit it has not seen yet. */
  readonly pollMillis?: number;
}

const DEFAULT_POLL = 250;

const parse = (json: string): unknown => JSON.parse(json);

/**
 * A `Domain.AggregateStore` over `SqlEventLog`.
 *
 * The log is the truth; this adapter is what keeps it that way. Each of the
 * five guarantees has exactly one place in this file:
 *
 * 1. **One writer per account** — `append` takes the account's lock inside its
 *    transaction, so two commands on one account serialize.
 * 2. **Dedupe by `commandId`** — a replay finds the stored receipt and returns
 *    it without deciding again, and `append` refuses a second write of the same
 *    id, so a retried webhook cannot become a second charge.
 * 3. **Atomic commits** — events, state, receipt and deliveries land in one
 *    transaction: a crash leaves all of a command or none of it.
 * 4. **At-least-once delivery, in order** — deliveries go to the outbox in the
 *    same transaction and are marked delivered only after their target
 *    accepted them, so a crash between commit and delivery replays.
 * 5. **`schedule` and `tail`** — a scheduled command is a row with a due time,
 *    so it survives a restart; a live read polls, which is the correct
 *    mechanism on a store another process may be committing to.
 *
 * `decide`, `evolve` and routing stay in the kernel: `kit.handle` produces the
 * events, state, reply and deliveries, and this store only persists them.
 *
 * ### Hosting a model on SQLite
 * **Example:** The same model, a durable store
 * ```typescript
 * const log = SqlEventLog(sql, { now: () => Date.now() });
 * const platform = Paykit.SqlPlatform(log);
 * yield* Bank.layer(BankHandlers).pipe(Effect.provide(platform));
 * ```
 *
 * @primitive
 */
export const SqlAggregateStore = (
  log: SqlEventLog,
  options: SqlAggregateStoreOptions,
): Effect.Effect<AggregateStore, never, never> =>
  Effect.sync(() => {
    const { aggregate } = options;
    const pollMillis = options.pollMillis ?? DEFAULT_POLL;

    /** The stored state and version, or the empty state of a new instance. */
    const read = (id: string): { state: unknown; version: number } => {
      const row = log.state(aggregate, id);
      return row === undefined
        ? { state: null, version: 0 }
        : { state: parse(row.state) as never, version: Number(row.version) };
    };

    /** Deliver what this aggregate has in the outbox, in order, then mark it done. */
    const drain = (id: string) =>
      Effect.suspend(() => {
        const bound = kit;
        if (bound === undefined) return Effect.void;
        const pending = log
          .pendingDeliveries()
          .filter((row) => row.aggregate === aggregate && row.account === id);
        if (pending.length === 0) return Effect.void;
        return Effect.forEach(
          pending,
          (row) =>
            Effect.sync(() => JSON.parse(row.delivery) as Delivery).pipe(
              Effect.flatMap((delivery) => bound.deliver(delivery as never)),
              Effect.andThen(Effect.sync(() => log.markDelivered(row.seq))),
            ),
          { discard: true },
        );
      });

    // Bound when the model builds this aggregate's store. The kernel never
    // calls `send` before that, so one closure is enough and no layer is
    // needed to carry the kit around.
    let kit: AggregateKit | undefined;

    const store: AggregateStore = {
      send: ((id: string, command: unknown, meta: SendMeta) =>
        Effect.gen(function* () {
          const bound = kit;
          if (bound === undefined) {
            return yield* Effect.die("aggregate store used before it was built");
          }

          // A receipt for this command id means the command already ran.
          const stored = log.receipt(aggregate, id, meta.commandId);
          if (stored !== undefined) {
            return { _tag: "Accepted" as const, receipt: parse(stored) as never };
          }

          const before = read(id);
          const handled = yield* bound.handle({
            id,
            state: before.state as never,
            version: before.version,
            command: command as never,
            commandId: meta.commandId,
            context: meta.context,
            now: options.now(),
            ...(meta.correlationId === undefined ? {} : { correlationId: meta.correlationId }),
            ...(meta.trace === undefined ? {} : { trace: meta.trace }),
            ...(meta.link === undefined ? {} : { link: meta.link }),
          });
          if (handled._tag === "Rejected") {
            return { _tag: "Rejected" as const, rejection: handled.rejection };
          }

          const receipt = {
            stream: `${aggregate}/${id}`,
            version: handled.version,
            events: handled.events.map((event) => event.event),
            reply: handled.reply,
          };
          const appended = log.append({
            aggregate,
            account: id,
            commandId: meta.commandId,
            at: options.now(),
            events: handled.events.map((event) => event.event),
            state: handled.state,
            receipt,
            deliveries: handled.deliveries,
          });
          // Another writer committed this command id in between; the log
          // deduped it, so its stored receipt is the answer, not ours.
          if (appended.duplicate) {
            const raced = log.receipt(aggregate, id, meta.commandId);
            if (raced === undefined) {
              return yield* Effect.die("a duplicate append left no receipt");
            }
            return { _tag: "Accepted" as const, receipt: parse(raced) as never };
          }

          yield* drain(id);
          return { _tag: "Accepted" as const, receipt: receipt as never };
        })) as AggregateStore["send"],

      schedule: ((id: string, command: unknown, meta: SendMeta, due: Due) =>
        Effect.gen(function* () {
          if (log.receipt(aggregate, id, meta.commandId) !== undefined) {
            return yield* new AlreadyExecuted({ aggregate, id, commandId: meta.commandId });
          }
          const at = "at" in due ? due.at : options.now() + due.afterMillis;
          log.schedule({
            aggregate,
            account: id,
            commandId: meta.commandId,
            dueAt: at,
            command: JSON.stringify({ command, meta }),
          });
          return at;
        })) as AggregateStore["schedule"],

      unschedule: ((id: string, commandId: string) =>
        Effect.gen(function* () {
          if (log.receipt(aggregate, id, commandId) !== undefined) {
            return yield* new AlreadyExecuted({ aggregate, id, commandId });
          }
          if (log.pendingFor(aggregate, id, commandId) === undefined) {
            return yield* new NotScheduled({ aggregate, id, commandId });
          }
          log.unschedule(aggregate, id, commandId);
        })) as AggregateStore["unschedule"],

      state: ((id: string) => Effect.sync(() => read(id) as never)) as AggregateStore["state"],

      events: ((id: string) =>
        Effect.sync(() =>
          log.events(aggregate, id).map((row) => storedEvent(id, row)),
        )) as AggregateStore["events"],

      // A poll is the correct mechanism here: another process may commit, so
      // there is nothing in this one to notify a subscriber. `changesWith`
      // drops an unchanged read, so a subscriber sees only commits.
      changes: (id) =>
        Stream.tick(Duration.millis(pollMillis)).pipe(
          Stream.mapEffect(() => Effect.sync(() => read(id))),
          Stream.changesWith((left, right) => left.version === right.version),
          Stream.filter((entry) => entry.version > 0),
          Stream.map((entry) => entry as never),
        ),

      tail: ((id: string, after: number) => {
        let seen = after;
        return Stream.tick(Duration.millis(pollMillis)).pipe(
          Stream.mapEffect(() =>
            Effect.sync(() => {
              const rows = log.events(aggregate, id, seen);
              if (rows.length > 0) seen = rows[rows.length - 1]!.seq;
              return rows;
            }),
          ),
          Stream.flatMap((rows) => Stream.fromIterable(rows)),
          Stream.map((row) => storedEvent(id, row)),
        );
      }) as AggregateStore["tail"],
    };

    // The kernel binds the store to its kit once the model is built; `store`
    // is the same object, so a caller that already holds it sees the binding.
    Object.assign(store, {
      bind: (built: AggregateKit) => {
        kit = built;
        return store;
      },
    });
    return store;
  });

const storedEvent = (
  id: string,
  row: {
    readonly seq: number;
    readonly at: number;
    readonly commandId: string;
    readonly event: string;
  },
): StoredEvent =>
  ({
    event: parse(row.event),
    envelope: { id, seq: row.seq, at: row.at, commandId: row.commandId },
  }) as unknown as StoredEvent;
