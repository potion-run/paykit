import { describe, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { outboundSignature } from "../../src/Outbound.ts";
import { assertProperty } from "../support/Property.ts";

const Case = Schema.Struct({
  secret: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  body: Schema.String,
  timestamp: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 0, maximum: 4_000_000_000_000 })),
  ),
  tamper: Schema.Literals(["body", "timestamp", "secret"]),
});

const headerOf = (signature: string) => {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signature);

  if (match === null) return null;

  return { timestamp: Number(match[1]), tag: match[2]! };
};

const verify = (secret: string, timestamp: number, body: string, tag: string): boolean => {
  const expected = new Bun.CryptoHasher("sha256", new TextEncoder().encode(secret))
    .update(`${timestamp}.${body}`)
    .digest("hex");

  return expected === tag;
};

describe("outbound signature", () => {
  it.effect("signs the timestamp and the body, and no other pair verifies", () =>
    assertProperty(
      Arbitrary.schema(Case),
      ({ secret, body, timestamp, tamper }) =>
        Effect.gen(function* () {
          const signature = yield* outboundSignature({
            secret: Redacted.make(secret),
            timestamp,
            body,
          });

          const parsed = headerOf(signature);

          if (parsed === null || parsed.timestamp !== timestamp) return false;

          if (!verify(secret, timestamp, body, parsed.tag)) return false;

          // The same bytes sign the same tag: a receiver can verify a retry.
          const again = yield* outboundSignature({
            secret: Redacted.make(secret),
            timestamp,
            body,
          });

          if (again !== signature) return false;

          const changedBody = tamper === "body" ? `${body} ` : body;
          const changedTimestamp = tamper === "timestamp" ? timestamp + 1 : timestamp;
          const changedSecret = tamper === "secret" ? `${secret}x` : secret;

          return !verify(changedSecret, changedTimestamp, changedBody, parsed.tag);
        }),
      { runs: 40, size: 20 },
    ),
  );
});
