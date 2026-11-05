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
  SendResult,
  StoredEvent,
} from "@alchemy.run/domain/Platform";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { SqlError } from "./Sql.ts";
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

/**
 * How many times one `send` re-reads and re-decides after another writer moved
 * the instance first. A winner commits a handful of rows, so contention on one
 * account is short; this is a ceiling on a pathological race, not on throughput.
 */
const MAX_SEND_ATTEMPTS = 32;

const parse = (json: string): unknown => JSON.parse(json);

/** What one attempt at a command settles to: an outcome, or the need to look again. */
type SendOutcome = SendResult | { readonly _tag: "Conflict" };

/**
 * A `Domain.AggregateStore` over `SqlEventLog`.
 *
 * The log is the truth; this adapter is what keeps it that way. Each of the
 * five guarantees has exactly one place in this file:
 *
 * 1. **One writer per account** — a commit runs in one transaction, so two
 *    commands on one instance serialize at the write. A decision taken outside
 *    that transaction carries the version it was made on: if the log moved, the
 *    append refuses it and the command is decided again, rather than published
 *    over a state it never saw.
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
    const read = (id: string) =>
      Effect.map(log.state(aggregate, id), (row) =>
        row === undefined
          ? { state: null, version: 0 }
          : { state: parse(row.state) as never, version: Number(row.version) },
      );

    /** Deliver what this aggregate has in the outbox, in order, then mark it done. */
    const drain = (id: string) =>
      Effect.gen(function* () {
        const bound = kit;
        if (bound === undefined) return;
        const waiting = yield* log.pendingDeliveries();
        const pending = waiting.filter((row) => row.aggregate === aggregate && row.account === id);
        if (pending.length === 0) return;
        yield* Effect.forEach(
          pending,
          (row) =>
            Effect.sync(() => JSON.parse(row.delivery) as Delivery).pipe(
              Effect.flatMap((delivery) => bound.deliver(delivery as never)),
              Effect.andThen(log.markDelivered(row.seq)),
            ),
          { discard: true },
        );
      });

    // Bound when the model builds this aggregate's store. The kernel never
    // calls `send` before that, so one closure is enough and no layer is
    // needed to carry the kit around.
    let kit: AggregateKit | undefined;

    /**
     * One read, one decide, one append — against the instance as it is now. It
     * answers `Conflict` when another writer committed between the read and the
     * append, because the decision then describes a state that is no longer the
     * instance's.
     */
    const attemptSend = (
      bound: AggregateKit,
      id: string,
      command: unknown,
      meta: SendMeta,
    ): Effect.Effect<SendOutcome, SqlError> =>
      Effect.gen(function* () {
        // A receipt for this command id means the command already ran.
        const stored = yield* log.receipt(aggregate, id, meta.commandId);
        if (stored !== undefined) {
          return { _tag: "Accepted" as const, receipt: parse(stored) as never };
        }

        const before = yield* read(id);
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
        const appended = yield* log.append({
          aggregate,
          account: id,
          commandId: meta.commandId,
          at: options.now(),
          events: handled.events.map((event) => event.event),
          state: handled.state,
          receipt,
          deliveries: handled.deliveries,
          // The version this decision was made on. Writing it past a newer one
          // would publish a state the events do not add up to; the caller looks
          // again instead.
          expectedVersion: before.version,
        });
        if (appended.conflict) return { _tag: "Conflict" as const };
        // Another writer committed this command id in between; the log deduped
        // it, so its stored receipt is the answer, not ours.
        if (appended.duplicate) {
          const raced = yield* log.receipt(aggregate, id, meta.commandId);
          if (raced === undefined) {
            return yield* Effect.die("a duplicate append left no receipt");
          }
          return { _tag: "Accepted" as const, receipt: parse(raced) as never };
        }

        yield* drain(id);
        return { _tag: "Accepted" as const, receipt: receipt as never };
      });

    /**
     * A command against the instance, re-decided as many times as another writer
     * gets there first. `decide` is pure, so a retry is not a second effect: it
     * is the same command over a state that moved.
     */
    const send = (
      bound: AggregateKit,
      id: string,
      command: unknown,
      meta: SendMeta,
      remaining: number,
    ): Effect.Effect<SendResult, SqlError> =>
      Effect.gen(function* () {
        const outcome = yield* attemptSend(bound, id, command, meta);
        if (outcome._tag !== "Conflict") return outcome;
        if (remaining === 0) {
          return yield* Effect.die(
            `${aggregate}/${id}: ${MAX_SEND_ATTEMPTS} writers kept moving the instance under ${meta.commandId}`,
          );
        }
        return yield* send(bound, id, command, meta, remaining - 1);
      });

    const store: AggregateStore = {
      send: ((id: string, command: unknown, meta: SendMeta) =>
        Effect.gen(function* () {
          const bound = kit;
          if (bound === undefined) {
            return yield* Effect.die("aggregate store used before it was built");
          }
          return yield* send(bound, id, command, meta, MAX_SEND_ATTEMPTS);
        }).pipe(Effect.orDie)) as AggregateStore["send"],

      schedule: ((id: string, command: unknown, meta: SendMeta, due: Due) =>
        Effect.gen(function* () {
          if ((yield* log.receipt(aggregate, id, meta.commandId)) !== undefined) {
            return yield* new AlreadyExecuted({ aggregate, id, commandId: meta.commandId });
          }
          const at = "at" in due ? due.at : options.now() + due.afterMillis;
          yield* log.schedule({
            aggregate,
            account: id,
            commandId: meta.commandId,
            dueAt: at,
            command: JSON.stringify({ command, meta }),
          });
          return at;
        }).pipe(Effect.orDie)) as AggregateStore["schedule"],

      unschedule: ((id: string, commandId: string) =>
        Effect.gen(function* () {
          if ((yield* log.receipt(aggregate, id, commandId)) !== undefined) {
            return yield* new AlreadyExecuted({ aggregate, id, commandId });
          }
          if ((yield* log.pendingFor(aggregate, id, commandId)) === undefined) {
            return yield* new NotScheduled({ aggregate, id, commandId });
          }
          yield* log.unschedule(aggregate, id, commandId);
        }).pipe(Effect.orDie)) as AggregateStore["unschedule"],

      // An infrastructure failure is a defect, not a value: the kernel's
      // interface declares no error channel here, so a broken store surfaces
      // through the platform rather than as a rejection a caller could match.
      state: ((id: string) =>
        Effect.map(read(id), (current) => current as never).pipe(
          Effect.orDie,
        )) as AggregateStore["state"],

      events: ((id: string) =>
        Effect.map(log.events(aggregate, id), (rows) =>
          rows.map((row) => storedEvent(id, row)),
        ).pipe(Effect.orDie)) as AggregateStore["events"],

      // A poll is the correct mechanism here: another process may commit, so
      // there is nothing in this one to notify a subscriber. `changesWith`
      // drops an unchanged read, so a subscriber sees only commits.
      changes: (id) =>
        Stream.tick(Duration.millis(pollMillis)).pipe(
          Stream.mapEffect(() => read(id)),
          Stream.changesWith((left, right) => left.version === right.version),
          Stream.filter((entry) => entry.version > 0),
          Stream.map((entry) => entry as never),
          Stream.orDie,
        ),

      tail: ((id: string, after: number) => {
        let seen = after;
        return Stream.tick(Duration.millis(pollMillis)).pipe(
          Stream.mapEffect(() =>
            Effect.map(log.events(aggregate, id, seen), (rows) => {
              if (rows.length > 0) seen = rows[rows.length - 1]!.seq;
              return rows;
            }),
          ),
          Stream.flatMap((rows) => Stream.fromIterable(rows)),
          Stream.map((row) => storedEvent(id, row)),
          Stream.orDie,
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
