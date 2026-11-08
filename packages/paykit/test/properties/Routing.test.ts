import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import { Memory, Manual } from "../../src/index.ts";
import { providerFor, type ProviderSet } from "../../src/Payments.ts";
import {
  initialSubscriptionState,
  type SubscriptionState,
} from "../../src/Subscription/Subscription.state.ts";
import { verifyState } from "../../src/Verify.ts";
import { MissingProviderRef, OrphanProviderRef, TierHasNoPurchasePath } from "../../src/Verify.ts";
import { assertProperty } from "../support/Property.ts";
import { subscribedAt, testCatalog } from "./Arbitraries.ts";

/** A provider set keyed the way `paymentsRouter` keys it. */
const setOf = (names: ReadonlyArray<string>): ProviderSet => {
  const all = names.map((name) => ({ ...Memory(), name }));

  return {
    all,
    byName: new Map(all.map((provider) => [provider.name, provider])),
    fallback: all[0] ?? null,
  };
};

const ProviderName = Schema.Literals(["a", "b", "z"]);
const RefKey = Schema.Literals(["a", "b", "z"]);

describe("provider routing", () => {
  it.effect("a ref names the provider, and the fallback serves an account with none", () =>
    assertProperty(
      Arbitrary.schema(Schema.Array(RefKey).pipe(Schema.check(Schema.isMaxLength(4)))),
      (keys) => {
        const set = setOf(["a", "b"]);
        const refs = Object.fromEntries(keys.map((key) => [key, {}]));
        const chosen = providerFor(set, refs);
        const firstKnown = keys.find((key) => key === "a" || key === "b");
        const expected = firstKnown ?? "a";

        if (chosen?.name !== expected) return false;

        // The same set and refs resolve the same provider: no map iteration
        // surprise, no fallback that ignores the refs.
        const again = providerFor(set, refs);

        return again?.name === chosen.name;
      },
      { runs: 80, size: 12 },
    ),
  );

  it.effect("a provider with two names still resolves only one of them", () =>
    assertProperty(
      Arbitrary.schema(Schema.Array(ProviderName).pipe(Schema.check(Schema.isMinLength(1)))),
      (names) => {
        const set = setOf(names);
        const chosen = providerFor(set, {});

        if (set.fallback === null) return chosen === null;

        return chosen?.name === set.fallback.name;
      },
      { runs: 40, size: 8 },
    ),
  );

  it("a provider is a value, not a lifecycle", () => {
    expect(Manual().name).toBe("manual");
    expect(Memory().name).toBe("memory");
  });
});

const Capability = Schema.Literals(["checkout", "invoice", "refund", "portal"]);

const VerifyCase = Schema.Struct({
  connected: Schema.Boolean,
  tier: Schema.Literals(["free", "pro"]),
  provider: Schema.optionalKey(
    Schema.Struct({
      name: Schema.Literals(["p", "q"]),
      capabilities: Schema.Array(Capability).pipe(Schema.check(Schema.isMaxLength(4))),
    }),
  ),
  refs: Schema.Array(Schema.Literals(["p", "q"])).pipe(Schema.check(Schema.isMaxLength(2))),
});

const withRefs = (state: SubscriptionState, keys: ReadonlyArray<string>): SubscriptionState => ({
  ...state,
  refs: Object.fromEntries(keys.map((key) => [key, { customer: `cus_${key}` }])),
});

describe("standing verification", () => {
  it.effect("judges the vendor reference, the sold tier and the purchase path", () =>
    assertProperty(
      Arbitrary.schema(VerifyCase),
      ({ connected, tier, provider, refs }) => {
        const state = connected
          ? withRefs(subscribedAt(tier), refs)
          : withRefs(initialSubscriptionState, refs);

        const target =
          provider === undefined
            ? null
            : { name: provider.name, capabilities: new Set(provider.capabilities) };

        const findings = verifyState("acct_verify_property", state, {
          catalog: testCatalog,
          provider: target,
        });

        const tags = findings.map((finding) => finding._tag);

        if (!connected) {
          return refs.length === 0
            ? tags.length === 0
            : tags.length === 1 &&
                tags[0] === "OrphanProviderRef" &&
                (findings[0] as OrphanProviderRef).provider === refs[0];
        }

        if (tier === "free") return tags.length === 0;

        if (target === null) return tags.length === 0;

        if (!refs.includes(target.name)) {
          return (
            tags.length === 1 &&
            tags[0] === "MissingProviderRef" &&
            (findings[0] as MissingProviderRef).provider === target.name
          );
        }

        const canSell = target.capabilities.has("checkout") || target.capabilities.has("invoice");

        return canSell
          ? tags.length === 0
          : tags.length === 1 &&
              tags[0] === "TierHasNoPurchasePath" &&
              (findings[0] as TierHasNoPurchasePath).tier === "pro";
      },
      { runs: 100, size: 16 },
    ),
  );
});
