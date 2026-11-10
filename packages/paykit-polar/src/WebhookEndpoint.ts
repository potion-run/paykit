import { unwrapRedactedDeep } from "@distilled.cloud/core/protocol-rest";
import * as Polar from "@distilled.cloud/polar";
import { encodeVendorPart } from "@potion.run/paykit";
import { Unowned } from "alchemy/AdoptPolicy";
import type { Input } from "alchemy/Input";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import { arrayEqualsUnordered } from "alchemy/Util/equal";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { Providers } from "./Providers.ts";

/**
 * The event types `Webhooks.ts` decodes. A Polar event outside this list is not
 * a standing change, so the deploy does not ask the endpoint to deliver it:
 * every delivery would be verified and then dropped.
 */
export const POLAR_WEBHOOK_EVENTS = [
  "checkout.updated",
  "order.paid",
  "subscription.past_due",
  "subscription.canceled",
  "subscription.revoked",
] as const satisfies ReadonlyArray<Polar.WebhookEventType>;

/** Where a deployment serves the Polar delivery route. */
export const DEFAULT_WEBHOOK_PATH = "/webhooks/polar";

/** The last segment a scope's endpoint carries when nothing narrower is named. */
const DEFAULT_WEBHOOK_NAME = "webhook";

/**
 * The name a stack and stage's webhook endpoint carries, and its identity.
 *
 * Polar's webhook endpoint has no metadata field, so the name is the only
 * place to carry the scope. The stack is part of it as well as the stage: two
 * stacks in one Polar organization can share a stage name, and with no
 * metadata to disambiguate them a stage-only name would make one deploy adopt
 * the other's endpoint. Every part is encoded, so a separator inside one
 * cannot forge another identity.
 */
export const webhookEndpointNameOf = (
  stack: string,
  stage: string,
  name: string = DEFAULT_WEBHOOK_NAME,
): string =>
  `paykit:${encodeVendorPart(stack)}:${encodeVendorPart(stage)}:${encodeVendorPart(name)}`;

/**
 * The prefix every webhook endpoint this scope owns starts with. The trailing
 * colon stops `prod` from matching `production`.
 */
export const webhookEndpointNamePrefixOf = (stack: string, stage: string): string =>
  `paykit:${encodeVendorPart(stack)}:${encodeVendorPart(stage)}:`;

/** The URL a deployment asks Polar to deliver to: the app's origin plus the route. */
export const webhookEndpointUrlOf = (origin: string, path?: string): string =>
  `${origin}${path ?? DEFAULT_WEBHOOK_PATH}`;

/** The payload format Polar can render a delivery as. */
export type WebhookEndpointFormat = "raw" | "discord" | "slack";

export interface WebhookEndpointProps {
  /** The HTTPS URL Polar posts deliveries to. */
  readonly url: string;
  /**
   * The event types this endpoint receives. Defaults to
   * `POLAR_WEBHOOK_EVENTS`, exactly the events `polarWebhook` translates.
   */
  readonly events?: ReadonlyArray<string>;
  /**
   * The payload format. `raw` is what paykit's decoder verifies, so that is
   * the default; `discord` and `slack` are for a chat integration.
   */
  readonly format?: WebhookEndpointFormat;
  /** Whether Polar delivers to this endpoint. Defaults to `true`. */
  readonly enabled?: boolean;
  /**
   * The last segment of the endpoint's name, appended to the scope prefix
   * `paykit:<stack>:<stage>:`. Defaults to `webhook`.
   *
   * The stack and stage always stay in front, because Polar has no metadata
   * field and the name is the only ownership evidence. A name therefore
   * narrows an endpoint inside its scope; it cannot move it to another.
   */
  readonly name?: string;
}

export type WebhookEndpoint = Resource<
  "Polar.WebhookEndpoint",
  WebhookEndpointProps,
  {
    /** The Polar webhook endpoint id. Its form is Polar's, so nothing spells it. */
    id: string;
    /** The full name, `paykit:<encoded stack>:<encoded stage>:<encoded segment>`. */
    name: string;
    /** The URL Polar posts deliveries to. */
    url: string;
    /** The event types the endpoint receives. */
    events: ReadonlyArray<string>;
    /** The payload format Polar renders a delivery as. */
    format: WebhookEndpointFormat;
    /** Whether Polar delivers to this endpoint. */
    enabled: boolean;
    /**
     * The signing secret the Worker verifies with. Polar returns it at create
     * and may omit it on a later read; state is where it is preserved. Never
     * log this value.
     */
    secret: Redacted.Redacted<string> | undefined;
    /** Polar's creation timestamp. */
    createdAt: string;
  },
  never,
  Providers
>;

/**
 * A Polar webhook endpoint, the destination a standing activation arrives at.
 *
 * `PolarBilling` creates it when the deploy has no `webhookSecret`: the URL is
 * the app's origin plus `/webhooks/polar`, the events are exactly the ones
 * `polarWebhook` decodes, and the secret Polar mints at create is handed to
 * the Worker. Supplying `webhookSecret` keeps the endpoint hand-managed and
 * creates nothing here.
 *
 * The identity is the name, `paykit:<stack>:<stage>:<segment>`, because a
 * Polar webhook endpoint has no metadata field. The scope prefix is what makes
 * a state-lost deploy adopt the endpoint it already made instead of creating a
 * second one, and `list` is scoped by the same prefix.
 *
 * Everything except the secret changes in place: `url`, `events`, `format`,
 * `enabled` and the name segment are all fields of
 * `WebhooksUpdateWebhookEndpointRequest`, so a change never replaces the
 * endpoint and never rotates its secret. The secret is not recoverable through
 * the API after create, which is why it is preserved from state.
 *
 * Removal is `destroy`. An endpoint is configuration, not financial history:
 * the deliveries it forwards are transient and a stack destroy has already
 * removed the Worker that would answer them. Leaving it behind would leave
 * Polar posting a retired URL. A product is the opposite and is retained, per
 * ADR 0003.
 *
 * ### Pointing Polar at a deployment
 * **Example:** One endpoint per stack and stage
 * ```typescript
 * const endpoint = yield* WebhookEndpoint("Webhook", {
 *   url: Output.interpolate`${api.url}/webhooks/polar`,
 * });
 * // The Worker verifies deliveries with the secret minted at create; pass the
 * // attribute into its environment, where the deploy resolves it.
 * const secret = endpoint.secret;
 * ```
 *
 * @resource
 * @product Webhook
 */
export const WebhookEndpoint = Resource<WebhookEndpoint>("Polar.WebhookEndpoint", {
  defaultRemovalPolicy: "destroy",
});

type VendorWebhookEndpoint = Polar.WebhookEndpoint;

/**
 * The signing secret from a create or a read, as this package's `Redacted`.
 *
 * The SDK may hold a `Redacted` from another copy of Effect, whose registry
 * this package's `Redacted.value` cannot read. Distilled's own unwrapper is
 * the fallback, the same reason Alchemy's Stripe provider has one.
 */
const redactSecret = (
  secret: string | Redacted.Redacted<string> | undefined,
): Redacted.Redacted<string> | undefined => {
  if (secret === undefined || secret === "") return undefined;

  if (typeof secret === "string") return Redacted.make(secret);

  try {
    const value = Redacted.value(secret);

    return typeof value === "string" && value.length > 0 ? Redacted.make(value) : undefined;
  } catch {
    const unwrapped = unwrapRedactedDeep(secret);

    return typeof unwrapped === "string" && unwrapped.length > 0
      ? Redacted.make(unwrapped)
      : undefined;
  }
};

const attrsOf = (
  endpoint: VendorWebhookEndpoint,
  previousSecret?: Redacted.Redacted<string>,
): WebhookEndpoint["Attributes"] => ({
  id: endpoint.id,
  name: endpoint.name ?? "",
  url: endpoint.url,
  events: [...endpoint.events],
  format: endpoint.format,
  enabled: endpoint.enabled,
  secret: redactSecret(endpoint.secret) ?? previousSecret,
  createdAt: endpoint.created_at,
});

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

const listAll = Effect.fn(function* () {
  const endpoints: VendorWebhookEndpoint[] = [];

  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const listed = yield* Polar.webhooksListWebhookEndpoints({
      limit: LIST_PAGE_SIZE,
      page,
    });

    endpoints.push(...listed.items);

    if (page >= listed.pagination.max_page || listed.items.length === 0) break;
  }

  return endpoints;
});

const getById = (id: string) =>
  Polar.webhooksGetWebhookEndpoint({ id }).pipe(
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const findByName = Effect.fn(function* (name: string) {
  return (yield* listAll()).find((endpoint) => (endpoint.name ?? "") === name);
});

const observe = Effect.fn(function* (input: { id?: string; name: string }) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);

    if (byId !== undefined) return byId;
  }

  return yield* findByName(input.name);
});

const ensure = Effect.fn(function* (input: {
  readonly name: string;
  readonly url: string;
  readonly events: ReadonlyArray<string>;
  readonly format: WebhookEndpointFormat;
}) {
  return yield* Polar.webhooksCreateWebhookEndpoint({
    url: input.url,
    name: input.name,
    format: input.format,
    events: [...input.events],
  }).pipe(
    // Two deploys can both observe "missing". Polar does not enforce a unique
    // name, but a conflict (or the 422 a duplicate sometimes comes back as) is
    // still the other deploy's write, not a failure to report: re-observe and
    // adopt it if it is there.
    Effect.catchTag(["Conflict", "UnprocessableEntity"], (error) =>
      Effect.gen(function* () {
        const existing = yield* findByName(input.name);

        return existing ?? (yield* error);
      }),
    ),
  );
});

/** An endpoint that answered without a secret leaves the Worker unable to verify a delivery. */
export class PolarWebhookSecretMissing extends Schema.TaggedError<PolarWebhookSecretMissing>()(
  "PolarWebhookSecretMissing",
  {
    /** The Polar endpoint id that answered without a secret. */
    endpoint: Schema.String,
    /** The URL the deploy asked Polar to deliver to. */
    url: Schema.String,
  },
) {}

/** Fail unless the endpoint answered with the secret the Worker verifies with. */
export const webhookSecretOrFail = (input: {
  readonly endpoint: string;
  readonly url: string;
  readonly secret: Redacted.Redacted<string> | undefined;
}): Effect.Effect<Redacted.Redacted<string>, PolarWebhookSecretMissing> =>
  input.secret === undefined
    ? Effect.fail(new PolarWebhookSecretMissing({ endpoint: input.endpoint, url: input.url }))
    : Effect.succeed(input.secret);

/**
 * The webhook endpoint a deployment serves Polar's deliveries on.
 *
 * It defaults to the events `polarWebhook` decodes and to the name the stack
 * and stage derive, so the common deployment states a URL and nothing else.
 *
 * ### Receiving Polar's events
 * **Example:** One endpoint per stack and stage
 * ```typescript
 * const endpoint = yield* polarWebhookEndpoint(`Webhook`, {
 *   url: "https://app.example.com/webhooks/polar",
 * });
 * // The Worker verifies deliveries with the secret minted at create; the
 * // billing result carries it into the environment as an Output.
 * ```
 *
 * @primitive
 * @product Polar
 */
export const polarWebhookEndpoint = Effect.fn("Polar.webhookEndpoint")(function* (
  id: string,
  props: { readonly url: Input<string>; readonly events?: ReadonlyArray<string> },
) {
  return yield* WebhookEndpoint(id, {
    url: props.url,
    events: [...(props.events ?? POLAR_WEBHOOK_EVENTS)],
  });
});

export const WebhookEndpointProvider = () =>
  Provider.succeed(WebhookEndpoint, {
    stables: ["id", "secret", "createdAt"],

    // url, name, events, format and enabled are all fields of
    // `WebhooksUpdateWebhookEndpointRequest`, so a change updates the endpoint
    // in place. Nothing here is create-only, and a replacement would mint a
    // new secret for no reason.
    diff: () => Effect.undefined,

    read: Effect.fn(function* ({ olds, output }) {
      const stack = yield* Stack;
      const name = output?.name ?? webhookEndpointNameOf(stack.name, stack.stage, olds.name);

      // The name is the only ownership evidence Polar keeps, so an endpoint
      // found by id under another name is not ours to adopt.
      const existing = yield* observe({ id: output?.id, name });

      if (existing === undefined) return undefined;
      const attrs = attrsOf(existing, output?.secret);

      return (existing.name ?? "") === name ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const stack = yield* Stack;
      const prefix = webhookEndpointNamePrefixOf(stack.name, stack.stage);

      return (yield* listAll())
        .filter((endpoint) => (endpoint.name ?? "").startsWith(prefix))
        .map((endpoint) => attrsOf(endpoint));
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const stack = yield* Stack;
      const name = webhookEndpointNameOf(stack.name, stack.stage, news.name);
      const url = news.url;
      const events = news.events ?? POLAR_WEBHOOK_EVENTS;
      const format = news.format ?? "raw";
      const enabled = news.enabled ?? true;
      const previousSecret = output?.secret;

      let current = yield* observe({ id: output?.id, name });

      if (current === undefined) {
        current = yield* ensure({ name, url, events, format });
      }

      const secret = yield* webhookSecretOrFail({
        endpoint: current.id,
        url: current.url,
        secret: redactSecret(current.secret) ?? previousSecret,
      });

      const nameChanged = (current.name ?? "") !== name;
      const urlChanged = current.url !== url;
      const eventsChanged = !arrayEqualsUnordered(current.events, events);
      const formatChanged = current.format !== format;
      const enabledChanged = current.enabled !== enabled;

      if (!nameChanged && !urlChanged && !eventsChanged && !formatChanged && !enabledChanged) {
        return attrsOf(current, previousSecret);
      }

      const updated = yield* Polar.webhooksUpdateWebhookEndpoint({
        id: current.id,
        ...(nameChanged ? { name } : {}),
        ...(urlChanged ? { url } : {}),
        ...(eventsChanged ? { events: [...events] } : {}),
        ...(formatChanged ? { format } : {}),
        ...(enabledChanged ? { enabled } : {}),
      });

      return attrsOf(updated, secret);
    }),

    // Deleting the destination is the point of destroying the Worker that
    // answered it. A missing endpoint is already the desired state.
    delete: Effect.fn(function* ({ output }) {
      yield* Polar.webhooksDeleteWebhookEndpoint({ id: output.id }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
