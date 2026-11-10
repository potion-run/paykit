import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * A per-key single-writer lock whose entries live only as long as someone is
 * using them.
 *
 * A store needs two fibers that fold the same key to serialize, but a plain
 * `Map` of semaphores keyed by account grows for the life of the process: a
 * Cloudflare isolate hides that, a long-lived Postgres host serving every
 * account does not. Here the map is a refcount instead — acquiring a key
 * creates or joins its entry, and the last release deletes it.
 *
 * The reference is taken before the fiber awaits the semaphore, so a fiber
 * that is *waiting* on a held key keeps the entry alive. Without that, the
 * holder's release would delete the entry, the waiter would still hold the old
 * semaphore, and a third fiber would create a second one for the key — two
 * writers, which is exactly what the lock exists to prevent.
 *
 * `size` and `activeKeys` are diagnostics for a test, not a handler: no code
 * path makes a decision from them, and a caller outside a test has no reason
 * to read them.
 */
export interface KeyedLock {
  /**
   * Run `effect` holding the key, waiting while another fiber holds it. The
   * reference is released on success, failure and interruption.
   */
  readonly withKey: <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Diagnostic only: how many keys currently hold a reference. */
  readonly size: () => number;
  /** Diagnostic only: the keys currently holding a reference, in insertion order. */
  readonly activeKeys: () => ReadonlyArray<string>;
}

interface Entry {
  readonly semaphore: Semaphore.Semaphore;
  references: number;
}

/** Build an empty lock. One instance belongs to one store, never to a module. */
export const KeyedLock = (): KeyedLock => {
  const entries = new Map<string, Entry>();

  // Both halves are plain functions over the map: they are the bookkeeping a
  // lock owns, not model logic, and the persistence-free total operations a
  // generator could call a million times.
  const acquire = (key: string): Entry => {
    const found = entries.get(key);

    if (found !== undefined) {
      found.references += 1;

      return found;
    }

    const created: Entry = { semaphore: Semaphore.makeUnsafe(1), references: 1 };

    entries.set(key, created);

    return created;
  };

  const release = (key: string, entry: Entry): void => {
    entry.references -= 1;

    if (entry.references > 0) return;

    // Identity, not the key: a waiter on the old entry cannot overlap with the
    // delete — it holds a reference — but a new acquisition after the delete
    // must create the next entry rather than inherit this one.
    if (entries.get(key) === entry) entries.delete(key);
  };

  return {
    withKey: (key, effect) =>
      Effect.suspend(() => {
        // Taken here, before `withPermits` can suspend this fiber, so the
        // entry a waiter blocks on is the entry its finalizer will release.
        const entry = acquire(key);

        return entry.semaphore
          .withPermits(1)(effect)
          .pipe(Effect.ensuring(Effect.sync(() => release(key, entry))));
      }),
    size: () => entries.size,
    activeKeys: () => [...entries.keys()],
  };
};
