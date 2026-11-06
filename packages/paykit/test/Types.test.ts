import { expect, it } from "@alchemy.run/test";
import { allowance, grant } from "../src/Allowance.ts";
import { feature, messages, type FeatureInput } from "../src/Feature.ts";
import { tier } from "../src/Tier.ts";

/**
 * The catalog validator is the authority for serialized input. These are the
 * same contradictions caught one layer earlier, in the editor, so a TypeScript
 * author never reaches the deploy with them. `@ts-expect-error` is the test:
 * if a constructor starts accepting one of these again, the directive becomes
 * an unused-expectation error.
 */
it("a flag cannot declare a rate card", () => {
  // @ts-expect-error a flag has no counter to price
  const sso = feature({ id: "sso", kind: "flag", creditRates: { default: 1 } });
  expect(sso.kind).toBe("flag");
});

it("an unlimited allowance cannot claim an overage", () => {
  // @ts-expect-error there is no end to be past
  const unlimited = allowance(messages, { included: "unlimited", overage: "bill" });
  expect(unlimited.overage).toBe("bill");
});

it("a cap needs a bill", () => {
  // @ts-expect-error a cap prices the billable part
  const capped = allowance(messages, { included: 100, cap: 10 });
  expect(capped.cap).toBe(10);
});

it("a money cap needs a unit price", () => {
  // @ts-expect-error a money ceiling needs a price to count it
  const capped = allowance(messages, { included: 100, overage: "bill", moneyCap: 10 });
  expect(capped.moneyCap).toBe(10);
});

it("a flag cannot be metered", () => {
  const sso = feature({ id: "sso", kind: "flag" });
  // @ts-expect-error a flag is granted with `grant()`, not counted
  const metered = allowance(sso, { included: 1 });
  expect(metered.kind).toBe("metered");
});

it("a metered feature cannot be granted", () => {
  const metered = feature({ id: "metered" });
  // @ts-expect-error a metered feature is counted, not granted
  const granted = grant(metered);
  expect(granted.kind).toBe("flag");
});

it("a subscription tier needs at least one grant", () => {
  // @ts-expect-error a tier that grants nothing could never activate
  const empty = tier({ id: "empty", grants: [] });
  expect(empty.grants).toEqual([]);
});

it("a one-off pack needs a price and credits", () => {
  // @ts-expect-error a pack is bought, so it has both
  const pack = tier({ id: "pack", kind: "one_off", grants: [] });
  expect(pack.kind).toBe("one_off");
});

it("accepts a FeatureInput value through the wide overload", () => {
  const input: FeatureInput = { id: "custom" };
  const custom = feature(input);
  expect(custom.kind).toBe("metered");
});
