import type { PolarWebhookRequest } from "../../src/Webhooks.ts";

/**
 * The signing secret every fixture uses, and the tier mapping `Polar()` is
 * given: one definition, so a webhook test and an end-to-end test sign the
 * same deployment.
 */
export const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
export const proPrice = { amount: 1900, currency: "usd", interval: "month" as const };
export const tiers = { pro: { price: proPrice, productId: "prod_123" } };

/**
 * An independent HMAC: `Bun.CryptoHasher` is not the `effect/crypto` path the
 * decoder uses, so a signature that verifies here proves both agree.
 */
export const sign = (input: {
  readonly id: string;
  readonly timestamp: string;
  readonly body: string;
  readonly legacy?: boolean;
}): string => {
  const bytes =
    input.legacy === true
      ? new TextEncoder().encode(secret)
      : Buffer.from(secret.slice("whsec_".length), "base64");

  const tag = new Bun.CryptoHasher("sha256", bytes)
    .update(`${input.id}.${input.timestamp}.${input.body}`)
    .digest("base64");

  return `v1,${tag}`;
};

/** A Polar delivery: the headers it signs and the body it signs them over. */
export const request = (input: {
  readonly id?: string;
  readonly body: unknown;
  readonly timestamp: string;
  readonly signature?: string;
  readonly legacy?: boolean;
}): PolarWebhookRequest => {
  const id = input.id ?? "msg_1";
  const body = typeof input.body === "string" ? input.body : JSON.stringify(input.body);

  return {
    headers: {
      "webhook-id": id,
      "webhook-timestamp": input.timestamp,
      "webhook-signature":
        input.signature ??
        sign({
          id,
          timestamp: input.timestamp,
          body,
          ...(input.legacy === true ? { legacy: true } : {}),
        }),
    },
    body,
  };
};
