import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";

/**
 * Check a generated property, and fail the test with the shrunk counterexample
 * and its replay token when it is falsified.
 *
 * `effect/Arbitrary` derives generators from Schema, shrinks the first failure,
 * and records a replay token. A property is the same `boolean` or `Effect`
 * shape it always was; only the inputs are generated.
 *
 * Use `runs` and `size` to keep a suite fast. A failing property prints the
 * token, which a developer pastes into `replay` to reproduce exactly that
 * counterexample.
 */
export const assertProperty = <A, E = never, R = never>(
  arbitrary: Arbitrary.Arbitrary<A>,
  property: (value: A) => boolean | Effect.Effect<boolean, E, R>,
  options: Arbitrary.CheckOptions = {},
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    const result = yield* Arbitrary.checkEffect(arbitrary, property, {
      runs: 100,
      size: 40,
      maxDiscards: 1_000,
      ...options,
    });
    const failure = Arbitrary.formatCheckFailure(result);
    if (failure !== undefined) {
      return yield* Effect.die(new Error(failure));
    }
  });
