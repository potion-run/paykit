import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import type { Allowance } from "../Allowance.ts";
import { Actor, system } from "../Auth/Actor.ts";
import type { Catalog } from "../Catalog.ts";
import type { CatalogMismatch } from "../CatalogMismatch.rejection.ts";
import { CatalogService } from "../CatalogService.ts";
import type { EntityId } from "../Customer.ts";
import type { Proration } from "../Proration.ts";
import { CancelGroup, UncancelGroup } from "../Subscription/CancelGroup.command.ts";
import { ChangeTier } from "../Subscription/ChangeTier.command.ts";
import { PlanNotInCatalog } from "../Subscription/PlanNotInCatalog.rejection.ts";
import { Resume } from "../Subscription/Resume.command.ts";
import { ScheduleCancellation } from "../Subscription/ScheduleCancellation.command.ts";
import { ScheduleTierChange } from "../Subscription/ScheduleTierChange.command.ts";
import { SetQuantity } from "../Subscription/SetQuantity.command.ts";
import { Subscribe } from "../Subscription/Subscribe.command.ts";
import { Subscription } from "../Subscription/Subscription.aggregate.ts";
import type { SubscriptionState } from "../Subscription/Subscription.state.ts";
import { currencyOf } from "../Subscription/Subscription.state.ts";
import { WithdrawTierChange } from "../Subscription/WithdrawTierChange.command.ts";
import {
  planChangeTier,
  scheduleTierChangeInputOf,
  subscribeInputOf,
  withGrants,
} from "../TierCommand.ts";
import { defaultPlanFor } from "./Cancel.binding.ts";

/** What a caller wants decided before anything is recorded. */
export type PreviewCommand =
  | {
      readonly kind: "subscribe";
      readonly tier: string;
      readonly grants?: ReadonlyArray<Allowance>;
    }
  | {
      readonly kind: "changeTier";
      readonly tier: string;
      readonly entityId?: EntityId;
      readonly grants?: ReadonlyArray<Allowance>;
    }
  | {
      readonly kind: "scheduleTierChange";
      readonly tier: string;
      readonly grants?: ReadonlyArray<Allowance>;
    }
  | { readonly kind: "withdrawTierChange" }
  | { readonly kind: "cancel" }
  | { readonly kind: "resume" }
  | { readonly kind: "cancelGroup"; readonly group: string }
  | { readonly kind: "uncancelGroup"; readonly group: string }
  | {
      readonly kind: "setQuantity";
      readonly feature: string;
      readonly quantity: number;
      readonly entityId?: EntityId;
    };

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

type Previewable =
  | Subscribe
  | ChangeTier
  | ScheduleTierChange
  | WithdrawTierChange
  | ScheduleCancellation
  | Resume
  | SetQuantity
  | CancelGroup
  | UncancelGroup;

/** What building a preview command produced: a command, a mismatch, or a name the catalog lacks. */
type BuiltCommand =
  | { readonly command: Previewable }
  | { readonly mismatch: CatalogMismatch }
  | null;

/**
 * The command a preview describes, built from the catalog the Stack deployed.
 * A tier change also carries the proration the same prices and period would
 * charge, because a preview is the only place that number can be shown before
 * it is committed. A bespoke set is judged here by the same guard the write
 * meets, so a preview never shows a deal the command would refuse (ADR 0041).
 */
const commandOf = (
  catalog: Catalog,
  input: PreviewCommand,
  state: SubscriptionState,
  now: DateTime.Utc,
): BuiltCommand => {
  if (input.kind === "cancel") return { command: new ScheduleCancellation() };

  if (input.kind === "resume") return { command: new Resume() };

  if (input.kind === "cancelGroup") {
    const fallback = defaultPlanFor(
      catalog,
      input.group,
      state._tag === "Subscribed" ? currencyOf(state) : undefined,
    );

    return {
      command: new CancelGroup({
        group: input.group,
        ...(fallback === undefined ? {} : { fallback }),
      }),
    };
  }

  if (input.kind === "uncancelGroup") {
    return { command: new UncancelGroup({ group: input.group }) };
  }

  if (input.kind === "setQuantity") {
    return {
      command: new SetQuantity({
        feature: input.feature,
        quantity: input.quantity,
        ...(input.entityId === undefined ? {} : { entity: input.entityId }),
        dedupeKey: "preview",
      }),
    };
  }

  if (input.kind === "withdrawTierChange") return { command: new WithdrawTierChange() };

  if (input.kind === "subscribe") {
    const subscribed = subscribeInputOf(catalog, input.tier);

    if (subscribed === null) return null;
    const granted = withGrants(catalog, subscribed, input.grants);

    return granted.mismatch === null
      ? { command: new Subscribe(granted.input) }
      : { mismatch: granted.mismatch };
  }

  if (input.kind === "scheduleTierChange") {
    const scheduled = scheduleTierChangeInputOf(
      catalog,
      input.tier,
      state._tag === "Subscribed" ? currencyOf(state) : undefined,
    );

    if (scheduled === null) return null;
    const granted = withGrants(catalog, scheduled, input.grants);

    return granted.mismatch === null
      ? { command: new ScheduleTierChange(granted.input) }
      : { mismatch: granted.mismatch };
  }

  const plan = planChangeTier(catalog, input.tier, state, now);

  if (plan === null) return null;
  const granted = withGrants(catalog, plan.input, input.grants);

  return granted.mismatch === null
    ? {
        command: new ChangeTier({
          ...granted.input,
          ...(input.entityId === undefined ? {} : { entity: input.entityId }),
        }),
      }
    : { mismatch: granted.mismatch };
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
export const previewOperation = Effect.fn("Paykit.Preview")(function* () {
  const catalog = yield* CatalogService;
  const subscription = yield* Subscription;

  return Effect.fn("Paykit.Preview.decide")(function* (input: PreviewInput) {
    const now = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
    const state = yield* subscription.state(Subscription.ref(input.account));
    const built = commandOf(catalog, input.command, state, now);

    if (built === null) {
      return yield* new PlanNotInCatalog({
        tier: "tier" in input.command ? input.command.tier : "*",
      });
    }

    if ("mismatch" in built) return yield* built.mismatch;
    const command = built.command;

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

    // SAFETY: the prediction is the kernel's decoded preview; this narrows it to the public read types.
    const events = prediction.events as ReadonlyArray<PreviewEvent>;
    const proration = prorationOf(events);

    // SAFETY: the prediction is the kernel's decoded preview; this narrows it to the public read types.
    return {
      _tag: "accepted",
      state: prediction.state as SubscriptionState,
      events,
      ...(proration === undefined ? {} : { proration }),
    } as const satisfies PreviewResult;
  });
});
