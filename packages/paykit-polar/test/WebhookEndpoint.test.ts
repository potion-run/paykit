import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  POLAR_WEBHOOK_EVENTS,
  PolarWebhookSecretMissing,
  webhookEndpointNameOf,
  webhookEndpointNamePrefixOf,
  webhookEndpointUrlOf,
  webhookSecretOrFail,
} from "../src/WebhookEndpoint.ts";

/**
 * The event types `polarWebhook` has a case for. Kept as a literal, not
 * imported from the decoder, so this test fails when either side grows an edge
 * the other does not have.
 */
const decodedEvents = [
  "checkout.updated",
  "order.paid",
  "subscription.past_due",
  "subscription.canceled",
  "subscription.revoked",
];

describe("the webhook endpoint identity", () => {
  it("derives the name from the stack and the stage, because Polar has no metadata", () => {
    expect(webhookEndpointNameOf("PaykitPolarExample", "prod")).toBe(
      "paykit:PaykitPolarExample:prod:webhook",
    );
    expect(webhookEndpointNamePrefixOf("PaykitPolarExample", "prod")).toBe(
      "paykit:PaykitPolarExample:prod:",
    );
  });

  it("encodes each part, so a separator inside one cannot forge another scope", () => {
    expect(webhookEndpointNameOf("a", "b:c")).not.toBe(webhookEndpointNameOf("a:b", "c"));
    expect(webhookEndpointNameOf("preview 1", "prod")).toBe("paykit:preview_20_1:prod:webhook");
  });

  it("keeps two stacks apart even when they share a stage name", () => {
    expect(webhookEndpointNameOf("app", "prod")).not.toBe(webhookEndpointNameOf("app2", "prod"));
    expect(webhookEndpointNameOf("app", "prod")).not.toBe(webhookEndpointNameOf("app", "preview"));
  });

  it("keeps the scope in front of an explicitly named endpoint", () => {
    expect(webhookEndpointNameOf("app", "prod", "billing")).toBe("paykit:app:prod:billing");
    expect(
      webhookEndpointNameOf("app", "prod", "billing").startsWith(
        webhookEndpointNamePrefixOf("app", "prod"),
      ),
    ).toBe(true);
  });
});

describe("the webhook endpoint URL", () => {
  it("appends the default route to the app's origin", () => {
    expect(webhookEndpointUrlOf("https://app.example.com")).toBe(
      "https://app.example.com/webhooks/polar",
    );
  });

  it("uses the configured route when one is given", () => {
    expect(webhookEndpointUrlOf("https://app.example.com", "/hooks/polar")).toBe(
      "https://app.example.com/hooks/polar",
    );
  });
});

describe("the subscribed events", () => {
  it("is exactly the set the decoder handles, so a delivery is never dropped", () => {
    expect([...POLAR_WEBHOOK_EVENTS]).toEqual(decodedEvents);
  });
});

describe("the signing secret", () => {
  it("is a tagged failure when the endpoint answers without one", () => {
    const error = Effect.runSync(
      Effect.flip(
        webhookSecretOrFail({
          endpoint: "wh_1",
          url: "https://app.example.com/webhooks/polar",
          secret: undefined,
        }),
      ),
    );

    expect(error._tag).toBe("PolarWebhookSecretMissing");
    expect(error).toBeInstanceOf(PolarWebhookSecretMissing);
    expect(error.endpoint).toBe("wh_1");
    expect(error.url).toBe("https://app.example.com/webhooks/polar");
  });

  it("passes through the secret the endpoint minted", () => {
    const secret = Redacted.make("whsec_test");

    expect(
      Effect.runSync(
        webhookSecretOrFail({
          endpoint: "wh_1",
          url: "https://app.example.com/webhooks/polar",
          secret,
        }),
      ),
    ).toBe(secret);
  });
});
