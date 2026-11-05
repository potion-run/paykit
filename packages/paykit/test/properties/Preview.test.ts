import * as Domain from "@alchemy.run/domain";
import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { tierTermsOf } from "../../src/Catalog.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { Preview, type PreviewCommand } from "../../src/Preview.ts";
import { ScheduleCancellation } from "../../src/Subscription/ScheduleCancellation.command.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { assertProperty } from "../support/Property.ts";
import {
  canonical,
  commandOf,
  decideAt,
  evolveAt,
  isAccepted,
  start,
  testCatalog,
  TierName,
} from "./Arbitraries.ts";

const World = PaykitModel.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore))).pipe(
  Layer.provide(Domain.InMemory),
  Layer.provideMerge(
    Layer.mergeAll(Layer.succeed(Actor, system("test")), catalogLayer(testCatalog)),
  ),
);

const Case = Schema.Struct({
  kind: Schema.Literals(["subscribe", "changeTier", "cancel"]),
  startTier: TierName,
  nextTier: TierName,
});

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

describe("preview", () => {
  it.effect("previews the same events and state the command would record", () =>
    assertProperty(
      Arbitrary.schema(Case),
      ({ kind, startTier, nextTier }) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(DateTime.toEpochMillis(start));
          const subscription = yield* Subscription;
          const ref = Subscription.ref("acct_preview_property");
          const terms = tierTermsOf(testCatalog, startTier);
          if (terms === null) return false;
          yield* subscription.send(ref, new Subscribe({ tier: startTier, ...terms }));
          const state = yield* subscription.state(ref);
          if (state._tag !== "Subscribed") return false;

          const command: PreviewCommand = kind === "cancel" ? { kind } : { kind, tier: nextTier };
          const preview = yield* Preview();
          const result = yield* preview({ account: ref.id, command });
          const now = start;
          const pureCommand =
            kind === "cancel"
              ? new ScheduleCancellation()
              : kind === "subscribe"
                ? (() => {
                    const next = tierTermsOf(testCatalog, nextTier);
                    return next === null ? null : new Subscribe({ tier: nextTier, ...next });
                  })()
                : commandOf({ _tag: "ChangeTier", tier: nextTier }, state, now);
          if (pureCommand === null) return false;

          const decision = decideAt(state, pureCommand, now, "preview-property");
          if (isAccepted(decision)) {
            if (result._tag !== "accepted") return false;
            const expected = evolveAt(state, decision, now, "preview-property");
            if (!same(canonical(result.state), canonical(expected))) return false;
            if (
              !same(
                result.events.map((event) => event._tag),
                decision.map((event) => event._tag),
              )
            ) {
              return false;
            }
            const eventProration = decision.find(
              (event) => (event as { readonly proration?: unknown }).proration !== undefined,
            );
            if (eventProration !== undefined) {
              const recorded = (eventProration as { readonly proration?: unknown }).proration;
              if (!same(result.proration, recorded)) return false;
            }
            return true;
          }

          return result._tag === "rejected" && result.rejection._tag === decision._tag;
        }).pipe(Effect.provide(World)),
      { runs: 30, size: 12 },
    ),
  );
});
