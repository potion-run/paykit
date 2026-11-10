import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import { Paykit } from "@potion.run/paykit";
import { D1 } from "@potion.run/paykit/Database/D1";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { answering, type Answered, type TurnPath } from "./Agent.ts";
import { Provider } from "./billing.config.ts";
import { BillingDatabase } from "./BillingDatabase.ts";
import { type AiModel, AI_RATES } from "./catalog.ts";
import { billingOn } from "./SqlBilling.ts";
import { project } from "./Workspace.ts";

type AskOutcome =
  | { readonly _tag: "answered"; readonly answered: Answered }
  | { readonly _tag: "refused"; readonly reason: string; readonly message: string };

/**
 * `POST /ask?project=proj_docs&model=default` — the product's one metered route.
 *
 * It is the deployment's own path, not one `Paykit.handler` mounts: the handler
 * owns the billing surface, and this is the work the billing exists for. It
 * reads the account the same way the handler's `/checkout` does — from the
 * deployment's session, here the development header — and runs the turn against
 * the model the handler already built, so the route cannot answer from a second
 * copy of the model.
 *
 * The retry key is the caller's `x-request-id`, not one this route invents: a
 * retried request must replay the conversation and the credit spend instead of
 * recording them twice.
 */
const ask = (turns: TurnPath, incoming: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const account = Paykit.accountFromHeaders(incoming.headers);
    const headers = Headers.fromInput(incoming.headers);
    const requestId = Option.getOrNull(Headers.get(headers, "x-request-id"));

    if (account === null)
      return HttpServerResponse.text("x-paykit-actor is required", { status: 401 });

    const url = new URL(incoming.url, "http://saas");
    const projectId = url.searchParams.get("project");
    const model = url.searchParams.get("model") ?? "default";

    if (projectId === null)
      return HttpServerResponse.text("?project= is required", { status: 400 });

    if (!Object.hasOwn(AI_RATES, model)) {
      return HttpServerResponse.text(`?model= must be one of ${Object.keys(AI_RATES).join(", ")}`, {
        status: 400,
      });
    }

    if (requestId === null) {
      return HttpServerResponse.text("x-request-id is required", { status: 400 });
    }

    // SAFETY: `Object.hasOwn(AI_RATES, model)` above narrowed the query value
    // to a key of the catalog's rate table.
    const outcome: AskOutcome = yield* turns
      .answer(account, {
        project: project(projectId),
        model: model as AiModel,
        requestId,
      })
      .pipe(
        Effect.map((answered) => ({ _tag: "answered" as const, answered })),
        Effect.catchTag("AgentRefused", (refusal) =>
          Effect.succeed({
            _tag: "refused" as const,
            reason: refusal.reason,
            message: refusal.message,
          }),
        ),
      );

    return outcome._tag === "refused"
      ? HttpServerResponse.jsonUnsafe(
          { refused: outcome.reason, message: outcome.message },
          { status: 402 },
        )
      : HttpServerResponse.jsonUnsafe(outcome.answered, { status: 200 });
  });

/**
 * The paths, served from one model hosted on one database:
 *
 * - `/api`      — `BillingApi`: customers, projects, balances, transfers, top-ups.
 * - `/plans`    — the plan operations: attach, update, preview, checked out.
 * - `/checkout` — ask the provider for a path to pay a plan.
 * - `/webhooks` — verify and apply a provider delivery.
 * - `/ask`      — the product's own metered route, tried before the built-ins.
 */
const handle = () =>
  Effect.gen(function* () {
    // Resolve the turn path once, from the model this handler serves. A route
    // that built its own world would read a second copy of the ledger.
    const turns = yield* answering;

    const handler = yield* Paykit.handler({
      provider: Provider,
      accountOf: (incoming) => Paykit.accountFromHeaders(incoming.headers),
      routes: [
        {
          path: "/ask",
          handle: (incoming) => ask(turns, incoming).pipe(Effect.orDie),
        },
      ],
    });

    return yield* handler.fetch;
  });

/**
 * The Worker's one handler: resolve the database binding the request carries,
 * build the world on it, and serve. The binding is resolved here and not at
 * construction because a D1 binding only exists inside a request — `raw` is the
 * deferred accessor the platform hands back, and `D1Like` is the Promise-shaped
 * slice of it the store asks for.
 */
const serve = () => ({
  fetch: Effect.gen(function* () {
    const database = yield* Paykit.Database;
    const now = yield* Clock.currentTimeMillis;
    const billing = billingOn(yield* database.runtime, { now: () => now });
    // The world already carries the deployment's one provider — the same
    // context a command resolves — so its layer is not merged again here.
    const world = billing.world;

    return yield* handle().pipe(Effect.provide(world), Effect.orDie);
  }).pipe(Effect.provide(Layer.mergeAll(D1(BillingDatabase), Cloudflare.D1.QueryDatabaseBinding))),
});

export default class SaasWorker extends Cloudflare.Worker<SaasWorker>()(
  "SaasWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    return serve();
  }).pipe(Effect.provide(DomainCloudflare.layerDurableObjects()), Effect.orDie),
) {}
