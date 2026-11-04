// Toolchain smoke test: proves the runner, the Effect runtime and the assertion
// library are wired. Replace it with the first Polar resource suite.
import { expect, test } from "@alchemy.run/test";
import * as Effect from "effect/Effect";

test("the Effect runtime runs", async () => {
  const value = await Effect.runPromise(Effect.succeed(2 + 2));
  expect(value).toBe(4);
});
