import * as Stripe from "@alchemy.run/stripe";
import { describe, expect, it } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { StripeBilling } from "../src/StripeBilling.ts";
import {
  STRIPE_WEBHOOK_EVENTS,
  StripeWebhookSecretMissing,
  stripeWebhookEndpoint,
  stripeWebhookUrl,
} from "../src/WebhookEndpoint.ts";

/**
 * The endpoint contract without a Stripe account: the URL the deploy derives,
 * the events it subscribes to, and the secret the endpoint mints.
 *
 * `Stripe.WebhookEndpoint` is the vendor package's resource, so this stands in
 * for it at the provider collection boundary. What a deploy asks of the vendor
 * — the URL, the event list and the description — is what these cases assert;
 * the vendor package's own suite owns the reconcile.
 */

/** What a deploy asked Stripe to create, in the order it asked. */
interface EndpointRequest {
  readonly url: string;
  readonly enabledEvents: ReadonlyArray<string>;
  readonly description: string | undefined;
}

const asked: Array<EndpointRequest> = [];

/** The secret the fake endpoint answers with, which a real create mints. */
let minted: Redacted.Redacted<string> | undefined;

const reset = (secret: Redacted.Redacted<string> | undefined): void => {
  asked.length = 0;
  minted = secret;
};

const webhookEndpointProvider = Provider.succeed(Stripe.WebhookEndpoint, {
  list: () => Effect.succeed([]),
  diff: () => Effect.undefined,
  reconcile: Effect.fn(function* ({ id, news }) {
    const enabledEvents = news.enabledEvents.map((event) =>
      typeof event === "string" ? event : event.type,
    );

    asked.push({ url: news.url, enabledEvents, description: news.description });

    return {
      id: `we_${id}`,
      url: news.url,
      enabledEvents: [...enabledEvents],
      description: news.description,
      apiVersion: undefined,
      application: undefined,
      connect: false,
      status: "enabled" as const,
      secret: minted,
      metadata: {},
      created: 1,
      livemode: false,
    };
  }),
  delete: Effect.fn(function* () {}),
});

/** A Stripe provider collection with only the endpoint in it: no key, no network. */
const providers = Layer.effect(
  Stripe.Providers,
  Provider.collection([Stripe.WebhookEndpoint]),
).pipe(Layer.provide(webhookEndpointProvider));

const { test } = Test.make({ providers });

test.provider("creates the endpoint the app's origin and the decoded events name", (stack) =>
  Effect.gen(function* () {
    reset(Redacted.make("whsec_minted"));
    yield* stack.destroy();

    yield* stack.deploy(
      stripeWebhookEndpoint("BillingWebhookEndpoint", {
        url: stripeWebhookUrl("https://app.example.com"),
      }),
    );

    expect(asked).toEqual([
      {
        url: "https://app.example.com/webhooks/stripe",
        enabledEvents: [...STRIPE_WEBHOOK_EVENTS],
        description: "paykit billing",
      },
    ]);
  }),
);

test.provider("delivers to the configured path and only the events it is given", (stack) =>
  Effect.gen(function* () {
    reset(Redacted.make("whsec_minted"));
    yield* stack.destroy();

    yield* stack.deploy(
      stripeWebhookEndpoint("BillingWebhookEndpoint", {
        url: stripeWebhookUrl("https://app.example.com", "/billing/stripe"),
        events: ["invoice.paid"],
      }),
    );

    expect(asked).toEqual([
      {
        url: "https://app.example.com/billing/stripe",
        enabledEvents: ["invoice.paid"],
        description: "paykit billing",
      },
    ]);
  }),
);

test.provider("carries the minted secret to the provider as an Output", (stack) =>
  Effect.gen(function* () {
    reset(Redacted.make("whsec_minted"));
    yield* stack.destroy();

    const billing = yield* stack.deploy(
      Effect.gen(function* () {
        const billing = yield* StripeBilling("Billing", {
          secretKey: Redacted.make("sk_test_fake"),
          origin: "https://app.example.com",
          tiers: {},
        });

        return {
          secret: billing.webhookEndpoint.secret,
          hasWebhook: billing.webhook !== undefined,
        };
      }),
    );

    // The stack program cannot resolve the endpoint's attribute, so the secret
    // is an Output until a consumer evaluates it — here the deploy resolving
    // what the program returned, which is what the Worker's environment does.
    expect(Redacted.value(billing.secret)).toBe("whsec_minted");
    expect(billing.hasWebhook).toBe(true);
  }),
);

test.provider("refuses an endpoint that answers without a signing secret", (stack) =>
  Effect.gen(function* () {
    reset(undefined);
    yield* stack.destroy();

    const defect = yield* stack
      .deploy(
        Effect.gen(function* () {
          const billing = yield* StripeBilling("Billing", {
            secretKey: Redacted.make("sk_test_fake"),
            origin: "https://app.example.com",
            tiers: {},
          });

          return { secret: billing.webhookEndpoint.secret };
        }),
      )
      .pipe(Effect.catchDefect((cause) => Effect.succeed(cause)));

    expect(defect).toBeInstanceOf(StripeWebhookSecretMissing);
    expect((defect as StripeWebhookSecretMissing)._tag).toBe("StripeWebhookSecretMissing");
    // The refusal names the endpoint that answered, which is the id Stripe
    // minted — the only handle a deploy can act on.
    expect((defect as StripeWebhookSecretMissing).endpoint).toBe("we_BillingWebhookEndpoint");
  }),
);

test.provider("keeps a hand-managed endpoint out of the deploy and lifts its secret", (stack) =>
  Effect.gen(function* () {
    reset(undefined);
    yield* stack.destroy();

    const billing = yield* stack.deploy(
      Effect.gen(function* () {
        const billing = yield* StripeBilling("Billing", {
          secretKey: Redacted.make("sk_test_fake"),
          origin: "https://app.example.com",
          tiers: {},
          webhookSecret: Redacted.make("whsec_by_hand"),
        });

        return {
          secret: billing.webhookEndpoint.secret,
          resource: billing.webhookEndpoint.resource,
          hasWebhook: billing.webhook !== undefined,
        };
      }),
    );

    expect(asked).toEqual([]);
    expect(Redacted.value(billing.secret)).toBe("whsec_by_hand");
    expect(billing.resource).toBe(undefined);
    expect(billing.hasWebhook).toBe(true);
  }),
);

describe("the webhook endpoint URL", () => {
  it("appends the default delivery route to the app's origin", () => {
    expect(stripeWebhookUrl("https://app.example.com")).toBe(
      "https://app.example.com/webhooks/stripe",
    );
  });

  it("uses the configured route when one is given", () => {
    expect(stripeWebhookUrl("https://app.example.com", "/billing/stripe")).toBe(
      "https://app.example.com/billing/stripe",
    );
  });
});

/**
 * The event types `stripeWebhook` has a case for. Kept as a literal, not
 * imported from the decoder, so this test fails when either side grows an edge
 * the other does not have.
 */
const decodedEvents = [
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.deleted",
];

describe("the subscribed events", () => {
  it("is exactly the set the decoder handles, so a delivery is never dropped", () => {
    expect([...STRIPE_WEBHOOK_EVENTS]).toEqual(decodedEvents);
  });
});
