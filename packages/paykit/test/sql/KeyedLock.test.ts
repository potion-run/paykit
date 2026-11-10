import { describe, expect, it } from "@alchemy.run/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import { KeyedLock } from "../../src/Store/KeyedLock.ts";

describe("a keyed lock", () => {
  it.effect("lets a second key run while the first is held", () =>
    Effect.gen(function* () {
      const lock = KeyedLock();
      const entered = yield* Deferred.make<void>();
      const held = yield* Deferred.make<void>();
      const ran = yield* Deferred.make<void>();

      const first = yield* Effect.forkChild(
        lock.withKey(
          "first",
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(held);
          }),
        ),
      );

      yield* Deferred.await(entered);

      const second = yield* Effect.forkChild(
        lock.withKey("second", Deferred.succeed(ran, undefined)),
      );

      yield* Effect.yieldNow;
      // The first key is still held; the second must not be behind it.
      expect(yield* Deferred.isDone(ran)).toBe(true);

      yield* Deferred.succeed(held, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
    }),
  );

  it.effect("serializes two fibers that hold the same key", () =>
    Effect.gen(function* () {
      const lock = KeyedLock();
      const order = yield* Ref.make<ReadonlyArray<string>>([]);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();

      const first = yield* Effect.forkChild(
        lock.withKey(
          "key",
          Effect.gen(function* () {
            yield* Ref.update(order, (seen) => [...seen, "first"]);
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
        ),
      );

      yield* Deferred.await(entered);

      const second = yield* Effect.forkChild(
        lock.withKey(
          "key",
          Effect.gen(function* () {
            yield* Ref.update(order, (seen) => [...seen, "second"]);
            yield* Deferred.succeed(secondEntered, undefined);
          }),
        ),
      );

      // Give the second fiber the executor: it suspends on the held key and
      // records nothing until the first releases it.
      yield* Effect.yieldNow;
      expect(yield* Ref.get(order)).toEqual(["first"]);
      expect(yield* Deferred.isDone(secondEntered)).toBe(false);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);

      expect(yield* Ref.get(order)).toEqual(["first", "second"]);
    }),
  );

  it.effect("keeps the entry alive while a fiber waits on it", () =>
    Effect.gen(function* () {
      const lock = KeyedLock();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const first = yield* Effect.forkChild(
        lock.withKey(
          "key",
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
        ),
      );

      yield* Deferred.await(entered);

      const second = yield* Effect.forkChild(lock.withKey("key", Effect.succeed("second")));

      yield* Effect.yieldNow;
      // The waiter holds a reference, so the holder's release cannot delete the
      // entry the waiter is about to acquire.
      expect(lock.size()).toBe(1);
      expect(lock.activeKeys()).toEqual(["key"]);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);

      expect(yield* Fiber.join(second)).toBe("second");
      expect(lock.size()).toBe(0);
    }),
  );

  it.effect("keeps the holder's entry when a queued waiter is interrupted", () =>
    Effect.gen(function* () {
      const lock = KeyedLock();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const ran = yield* Deferred.make<void>();

      const holder = yield* Effect.forkChild(
        lock.withKey(
          "key",
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
        ),
      );

      yield* Deferred.await(entered);

      const queued = yield* Effect.forkChild(lock.withKey("key", Deferred.succeed(ran, undefined)));

      // Give the waiter the executor: it takes a reference and suspends on the
      // held key without running its effect.
      yield* Effect.yieldNow;
      expect(yield* Deferred.isDone(ran)).toBe(false);
      expect(lock.size()).toBe(1);
      expect(lock.activeKeys()).toEqual(["key"]);

      yield* Fiber.interrupt(queued);

      // The waiter's reference is gone, but the holder still owns the entry.
      expect(lock.size()).toBe(1);
      expect(lock.activeKeys()).toEqual(["key"]);
      expect(yield* Deferred.isDone(ran)).toBe(false);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);

      expect(lock.size()).toBe(0);
      expect(lock.activeKeys()).toEqual([]);
    }),
  );

  it.effect("releases the entry when the holder fails or is interrupted", () =>
    Effect.gen(function* () {
      const lock = KeyedLock();

      yield* Effect.exit(lock.withKey("failed", Effect.fail("boom")));
      expect(lock.size()).toBe(0);

      const entered = yield* Deferred.make<void>();

      const held = yield* Effect.forkChild(
        lock.withKey(
          "interrupted",
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);

            return yield* Effect.never;
          }),
        ),
      );

      yield* Deferred.await(entered);
      yield* Fiber.interrupt(held);

      expect(lock.size()).toBe(0);
    }),
  );

  it.effect("leaves no entry after 500 distinct keys complete", () =>
    Effect.gen(function* () {
      const lock = KeyedLock();
      const keys = Array.from({ length: 500 }, (_, index) => `key-${index}`);

      yield* Effect.forEach(keys, (key) => lock.withKey(key, Effect.void), {
        concurrency: "unbounded",
      });

      expect(lock.size()).toBe(0);
      expect(lock.activeKeys()).toEqual([]);
    }),
  );
});
