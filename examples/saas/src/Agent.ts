import { Paykit } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type AiModel, ai, aiCostOf, conversations } from "./catalog.ts";
import type { Project } from "./Workspace.ts";

/**
 * The product's one metered path: answer a support conversation with a model.
 *
 * It is the part of the example a customer actually feels, and it is why the
 * three surfaces no other example proves exist together: the work is scoped to a
 * project, it spends the org's shared pool, it burns the org's credits, and it
 * has to stop at the ceiling the customer set. Every number the path charges is
 * read from the catalog, so a turn cannot be quoted at a rate the pool is not
 * charged.
 */

/** One turn of the agent, as the deployment receives it. */
export interface Turn {
  /**
   * The project the conversation belongs to. Absent means the organization's own
   * scope, which is where a plan's billed overage is judged.
   */
  readonly project?: Project;
  /** The model that serves the call. It prices the credits, not the reply. */
  readonly model: AiModel;
  /** The caller's retry key. It is also the command id of each fact below. */
  readonly requestId: string;
}

/** What a turn did: the reply, and the two balances it moved. */
export interface Answered {
  readonly reply: string;
  /** What the project has left of conversations, after the turn. */
  readonly remaining: number | null;
  /** The credit pool after the model call. */
  readonly credits: number;
}

/**
 * Why the product refused to run a turn. A refusal is not a defect: the request
 * was understood, the work did not happen, and nothing was recorded, so a caller
 * may show an upgrade or a ceiling and retry. The `reason` says which model fact
 * refused, so a page can say "add credits" instead of "payment failed".
 */
export class AgentRefused extends Schema.TaggedError<AgentRefused>()("AgentRefused", {
  account: Schema.String,
  /** The project, when the turn was scoped to one; absent is the org's own scope. */
  project: Schema.optionalKey(Schema.String),
  feature: Schema.String,
  reason: Schema.Literals(["allowance", "spend_limit", "standing", "credits"]),
  message: Schema.String,
}) {}

/** The refusal a model rejection means, in the product's words. */
const refusalOf =
  (account: string, turn: Turn) =>
  (error: { readonly _tag: string; readonly feature?: string }): AgentRefused =>
    new AgentRefused({
      account,
      ...(turn.project === undefined ? {} : { project: turn.project }),
      feature: error.feature ?? conversations.id,
      reason:
        error._tag === "SpendLimitExceeded"
          ? "spend_limit"
          : error._tag === "StandingBlocksUsage" || error._tag === "StandingEnded"
            ? "standing"
            : error._tag === "CreditExceedsBalance"
              ? "credits"
              : "allowance",
      message: error._tag,
    });

/**
 * The turn path, with its three bindings resolved once.
 *
 * `Paykit.handler` builds its own routes from services it resolves itself, and a
 * deployment's own route may not require a second copy of the model (the same
 * reason `examples/billing` resolves its MCP handler this way). Resolving the
 * verbs here and closing over them gives the Worker's `/ask` route the model the
 * handler serves, not a second one.
 */
export const answering = Effect.gen(function* () {
  const checkOf = yield* Paykit.Check;
  const trackOf = yield* Paykit.TrackUsage;
  const creditsOf = yield* Paykit.ConsumeCredits;

  /**
   * Answer one conversation.
   *
   * The order is the billing order, and each step is one fact:
   *
   * 1. `check` reads one local row. It never calls a provider, so a page can
   *    render the answer in the same request. The ceiling the customer set is
   *    part of the judgement, so a turn over it answers `allowed: false` instead
   *    of billing.
   * 2. A second `check` judges the credit pool at the model's rate. The pool is
   *    read, not spent: a call that cannot pay for itself must not record a
   *    conversation first.
   * 3. The model call would sit here. The example echoes the prompt, so a reader
   *    can run the whole path without a model key; the billing shape does not
   *    move.
   * 4. `track` records the conversation in the transaction that judges the
   *    allowance. A blocking allowance refuses before anything is written.
   * 5. `consumeCredits` spends the model's rate from the org's one pool.
   *
   * The two writes share the caller's request id, so a retried turn replays both
   * facts instead of recording a second conversation and a second charge.
   *
   * ### A turn that hits the customer's ceiling
   * **Example:** The typed refusal, not a thrown error
   * ```typescript
   * const { answer } = yield* answering;
   * const turn = yield* answer(account, { project, model: "gpt-large", requestId }).pipe(
   *   Effect.catchTag("AgentRefused", (refusal) => Effect.succeed(refusal)),
   * );
   * if (turn instanceof AgentRefused) return respond(402, turn.reason);
   * ```
   *
   * @primitive
   */
  const answer = Effect.fn("Saas.answer")(function* (account: string, turn: Turn) {
    const check = yield* checkOf(account);
    const track = yield* trackOf(account);
    const credits = yield* creditsOf(account);

    const asked = yield* check({
      featureId: conversations.id,
      requiredBalance: 1,
      ...(turn.project === undefined ? {} : { entityId: turn.project }),
    }).pipe(
      Effect.catchTags({
        SpendLimitExceeded: (error) => Effect.fail(refusalOf(account, turn)(error)),
        SpendCapExceeded: (error) => Effect.fail(refusalOf(account, turn)(error)),
        MoneyCapExceeded: (error) => Effect.fail(refusalOf(account, turn)(error)),
        StandingBlocksUsage: (error) => Effect.fail(refusalOf(account, turn)(error)),
      }),
    );

    if (!asked.allowed) {
      return yield* new AgentRefused({
        account,
        ...(turn.project === undefined ? {} : { project: turn.project }),
        feature: conversations.id,
        reason: asked.balance.spendLimit?.remaining === 0 ? "spend_limit" : "allowance",
        message:
          asked.balance.spendLimit?.remaining === 0
            ? "the organization reached its monthly overage ceiling"
            : "the project has no conversation left this period",
      });
    }

    // The pool is judged before the work, with the same local read: a model
    // call that cannot pay for itself must not record a conversation first.
    const cost = aiCostOf(turn.model);
    const wallet = yield* check({ featureId: ai.id, requiredBalance: cost });

    if (!wallet.allowed) {
      return yield* new AgentRefused({
        account,
        ...(turn.project === undefined ? {} : { project: turn.project }),
        feature: ai.id,
        reason: "credits",
        message: "the organization has no credits left for this model",
      });
    }

    // The model call. It sits between the check and the write on purpose: a
    // provider call inside the transaction would make the transaction wait on
    // the network, and a failure after the fact is what a hold exists for.
    const reply = `The agent answered ${turn.requestId} on ${turn.model}.`;

    const recorded = yield* track({
      featureId: conversations.id,
      ...(turn.project === undefined ? {} : { entityId: turn.project }),
      value: 1,
      idempotencyKey: `${turn.requestId}:conversation`,
    }).pipe(
      Effect.catchTags({
        AllowanceExceeded: (error) => Effect.fail(refusalOf(account, turn)(error)),
        SpendLimitExceeded: (error) => Effect.fail(refusalOf(account, turn)(error)),
        SpendCapExceeded: (error) => Effect.fail(refusalOf(account, turn)(error)),
        MoneyCapExceeded: (error) => Effect.fail(refusalOf(account, turn)(error)),
        StandingBlocksUsage: (error) => Effect.fail(refusalOf(account, turn)(error)),
      }),
    );

    const spent = yield* credits({
      amount: cost,
      dedupeKey: `${turn.requestId}:credits`,
    }).pipe(
      Effect.catchTags({
        CreditExceedsBalance: (error) => Effect.fail(refusalOf(account, turn)(error)),
        StandingEnded: (error) => Effect.fail(refusalOf(account, turn)(error)),
      }),
    );

    return {
      reply,
      remaining: recorded.balance.remaining,
      credits: spent.balance,
    } satisfies Answered;
  });

  return { answer };
});

/**
 * The customer's guardrails, in the product's words: a monthly money ceiling on
 * overage, a page at a usage threshold, and whether the installed refill policy
 * may charge the saved method on this account.
 *
 * They are state on the customer, not catalog data, so a support agent can lower
 * a ceiling, move the page or switch refills off without a deploy, and the log
 * records what was in force when each spend happened (ADR 0038).
 */
export interface Guardrails {
  /** The most overage, in cents, this period. Absent means no ceiling. */
  readonly monthlyCeiling?: number;
  /** Page the org at this many conversations this period. */
  readonly alertAt?: number;
  /** Whether the deployment's refill policy may buy a pack for this org. */
  readonly refill?: boolean;
}

/** Replace the customer's guardrails. `undefined` clears one; `{}` clears all. */
export const setGuardrails = Effect.fn("Saas.setGuardrails")(function* (
  account: string,
  guardrails: Guardrails,
) {
  const customers = yield* Paykit.Customers(account);

  const billingControls = {
    ...(guardrails.monthlyCeiling === undefined
      ? {}
      : {
          spendLimits: [{ featureId: conversations.id, amount: guardrails.monthlyCeiling }],
        }),
    ...(guardrails.alertAt === undefined
      ? {}
      : { usageAlerts: [{ featureId: conversations.id, at: guardrails.alertAt }] }),
    ...(guardrails.refill === undefined ? {} : { autoTopUp: { enabled: guardrails.refill } }),
  };

  const written = yield* customers.update({ billingControls });

  return written.billingControls;
});

/** The resolved turn path: one model, one set of verbs, no second copy. */
export type TurnPath = Effect.Success<typeof answering>;
