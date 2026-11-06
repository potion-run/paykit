import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { allowance } from "../../src/Allowance.ts";
import { InsecureDevGuards } from "../../src/Auth/FromHeaders.ts";
import { BillingApiLayer } from "../../src/Billing/BillingApi.layer.ts";
import { BillingInProcess } from "../../src/Billing/BillingInProcess.layer.ts";
import { BindingCall } from "../../src/Billing/Bindings.ts";
import {
  ChargeProration,
  ChangeTier,
  Check,
  ConsumeCredits,
  Hold,
  List,
  Portal,
  Preview,
  ReleaseHold,
  Resume,
  ScheduleCancellation,
  ScheduleTierChange,
  SettleHold,
  StartTrial,
  Subscribe,
  TrackUsage,
  Webhook,
  WithdrawTierChange,
} from "../../src/Billing/index.ts";
import { BillingApi } from "../../src/BillingApi.api.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { catalog } from "../../src/Catalog.ts";
import { CatalogGuardLive } from "../../src/CatalogGuard.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { messages } from "../../src/Feature.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { tier } from "../../src/Tier.ts";

// Nothing here sends a command, so one tier with one allowance is enough: the
// test asks which tags the layers hold, not what they answer.
const testCatalog = Effect.runSync(
  catalog({
    features: [messages],
    tiers: [tier({ id: "free", grants: [allowance(messages, { included: 100 })] })],
  }),
);

const Model = PaykitModel.layer(PaykitHandlers)
  .pipe(Layer.provideMerge(MemoryBillingReadStore))
  .pipe(Layer.provide(Domain.InMemory))
  .pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        InsecureDevGuards,
        CatalogGuardLive.pipe(Layer.provideMerge(catalogLayer(testCatalog))),
      ),
    ),
  );

const inProcessWorld = Layer.mergeAll(BillingInProcess, catalogLayer(testCatalog)).pipe(
  Layer.provideMerge(Model),
);

const apiWorld = Layer.mergeAll(BillingApiLayer, catalogLayer(testCatalog)).pipe(
  Layer.provide(BillingApi.layerClientInProcess),
  Layer.provideMerge(Model),
  Layer.provide(Layer.succeed(BindingCall, { headers: { "x-paykit-actor": "acct_surface" } })),
);

/** The tags a caller may resolve from a layer, asked one at a time. */
/** Is this binding in the context the layer built? */
const provided = <A extends { readonly key: string }>(tag: A) =>
  Effect.gen(function* () {
    // A tag is a value and a type at once; the helper only needs to know the
    // service is there, so the shape is erased at this one line.
    const held = yield* Effect.serviceOption(tag as never);
    return Option.isSome(held);
  });

/** The command bindings: a request is derivable from the caller's fields plus the catalog. */
const commands = [
  Check,
  TrackUsage,
  Hold,
  SettleHold,
  ReleaseHold,
  ConsumeCredits,
  ScheduleCancellation,
  Resume,
  ScheduleTierChange,
  WithdrawTierChange,
  StartTrial,
] as const;

/** The operations: they need the standing, a provider, or the deployment's scope. */
const operations = [
  ChangeTier,
  Subscribe,
  Preview,
  Portal,
  ChargeProration,
  List,
  Webhook,
] as const;

describe("the binding surface a layer provides", () => {
  it.live("the in-process layer provides every binding", () =>
    Effect.gen(function* () {
      for (const tag of [...commands, ...operations]) {
        expect([tag.key, yield* provided(tag)]).toEqual([tag.key, true]);
      }
    }).pipe(Effect.provide(inProcessWorld)),
  );

  it.live("the Api layer provides the commands and no operation", () =>
    Effect.gen(function* () {
      for (const tag of commands) {
        expect([tag.key, yield* provided(tag)]).toEqual([tag.key, true]);
      }
      // An operation is work the Api does not serve: a remote deployment exposes
      // it on its own route, never by handing the caller a tag it cannot honour.
      for (const tag of operations) {
        expect([tag.key, yield* provided(tag)]).toEqual([tag.key, false]);
      }
    }).pipe(Effect.provide(apiWorld)),
  );

  it("every binding names itself exactly once", () => {
    const keys = [...commands, ...operations].map((tag) => tag.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key.startsWith("Paykit.")).toBe(true);
  });
});
