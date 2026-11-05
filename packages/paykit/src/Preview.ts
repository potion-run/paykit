import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { Actor, system } from "./Auth/Actor.ts";
import { type Catalog, tierOf, tierTermsOf } from "./Catalog.ts";
import { CatalogService } from "./CatalogService.ts";
import { prorate, type Proration } from "./Proration.ts";
import { ChangeTier } from "./Subscription/ChangeTier.command.ts";
import { ScheduleCancellation } from "./Subscription/ScheduleCancellation.command.ts";
import { Subscribe } from "./Subscription/Subscribe.command.ts";
import { Subscription } from "./Subscription/Subscription.aggregate.ts";
import type { SubscriptionState } from "./Subscription/Subscription.state.ts";
import { TierNotInCatalog } from "./Subscription/TierNotInCatalog.rejection.ts";

/** What a caller wants decided before anything is recorded. */
export type PreviewCommand =
  | { readonly kind: "subscribe"; readonly tier: string }
  | { readonly kind: "changeTier"; readonly tier: string }
  | { readonly kind: "cancel" };

/** The account and the action to decide without recording. */
export interface PreviewInput {
  readonly account: string;
  readonly command: PreviewCommand;
}

/** The events a preview says the command would record. */
export type PreviewEvent = Readonly<{ readonly _tag: string }> & {
  readonly proration?: Proration;
};

/**
 * What `decide` would do: the events it would record and the state after
 * them, the rejection it would return, or `unpredictable` for a decision only
 * the server can make.
 */
export type PreviewResult =
  | {
      readonly _tag: "accepted";
      readonly state: SubscriptionState;
      readonly events: ReadonlyArray<PreviewEvent>;
      /** The money this command moves, when it moves any. */
      readonly proration?: Proration;
    }
  | { readonly _tag: "rejected"; readonly rejection: Schema.Top["Type"] }
  | { readonly _tag: "unpredictable"; readonly cause: unknown };

type Previewable = Subscribe | ChangeTier | ScheduleCancellation;

/**
 * The command a preview describes, built from the catalog the Stack deployed.
 * A tier change also carries the proration the same prices and period would
 * charge, because a preview is the only place that number can be shown before
 * it is committed.
 */
const commandOf = (
  catalog: Catalog,
  input: PreviewCommand,
  state: SubscriptionState,
  now: DateTime.Utc,
): Previewable | null => {
  if (input.kind === "cancel") return new ScheduleCancellation();
  const tier = tierOf(catalog, input.tier);
  const terms = tierTermsOf(catalog, input.tier);
  if (terms === null || tier === null) return null;
  // The catalog-derived fields travel together: a command that carried the
  // allowances but not the credit terms would be refused by `CatalogGuard`.
  const { allowances, credits, creditsExpire, rates } = terms;
  const price = tier.price === undefined ? {} : { price: tier.price };
  if (input.kind === "subscribe") {
    return new Subscribe({ tier: input.tier, allowances, credits, creditsExpire, rates, ...price });
  }
  const midCycle =
    state._tag === "Subscribed"
      ? prorate({
          from: state.price,
          to: tier.price,
          period: { start: state.period.start, end: state.period.end },
          at: now,
        })
      : null;
  return new ChangeTier({
    tier: input.tier,
    allowances,
    credits,
    creditsExpire,
    rates,
    ...price,
    ...(midCycle === null ? {} : { proration: midCycle }),
  });
};

const prorationOf = (events: ReadonlyArray<PreviewEvent>): Proration | undefined =>
  events.find((event) => event.proration !== undefined)?.proration;

/**
 * Decide a `Subscribe`, `ChangeTier` or `ScheduleCancellation` against an
 * account's current state and return the outcome, without sending it. The
 * events a preview lists are the events the command would record, and the
 * proration it lists is what the command would charge, because a preview runs
 * the same pure `decide` the model runs. A preview can therefore never
 * disagree with the write it previews, and a console or an agent can show the
 * charge before anyone agrees to it.
 *
 * ### Showing a charge before it happens
 * **Example:** Preview, then apply only on confirmation
 * ```typescript
 * const preview = yield* Paykit.Preview({
 *   account,
 *   command: { kind: "changeTier", tier: "scale" },
 * });
 * if (preview._tag === "accepted" && (preview.proration?.due ?? 0) > 0) {
 *   const confirmed = yield* ask(preview.proration!.due);
 *   if (confirmed) yield* changeTier({ account, tier: "scale" });
 * }
 * ```
 *
 * @primitive
 */
export const Preview = Effect.fn("Paykit.Preview")(function* () {
  const catalog = yield* CatalogService;
  const subscription = yield* Subscription;

  return Effect.fn("Paykit.Preview.decide")(function* (input: PreviewInput) {
    const now = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
    const state = yield* subscription.state(Subscription.ref(input.account));
    const command = commandOf(catalog, input.command, state, now);
    if (command === null) {
      return yield* new TierNotInCatalog({
        tier: input.command.kind === "cancel" ? "*" : input.command.tier,
      });
    }
    // A preview runs the guarded command's own `decide`, which needs the
    // caller its middleware would have provided. `decide` never reads it, but
    // the prediction carries it the way a send would.
    const actor = Option.getOrElse(yield* Effect.serviceOption(Actor), () => system("preview"));
    const prediction = Subscription.predict(state, command, {
      id: Subscription.ref(input.account).id,
      now,
      context: Context.make(Actor, actor),
    });
    if (prediction._tag === "Rejected") {
      return {
        _tag: "rejected",
        rejection: prediction.rejection,
      } as const satisfies PreviewResult;
    }
    if (prediction._tag === "Unpredictable") {
      return { _tag: "unpredictable", cause: prediction.cause } as const satisfies PreviewResult;
    }
    const events = prediction.events as ReadonlyArray<PreviewEvent>;
    const proration = prorationOf(events);
    return {
      _tag: "accepted",
      state: prediction.state as SubscriptionState,
      events,
      ...(proration === undefined ? {} : { proration }),
    } as const satisfies PreviewResult;
  });
});
