import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { allowance } from "../../src/Allowance.ts";
import { Actor, system } from "../../src/Auth/Actor.ts";
import { MemoryBillingReadStore } from "../../src/BillingReadStore.ts";
import { allowancesOf, catalog } from "../../src/Catalog.ts";
import { catalogLayer } from "../../src/CatalogService.ts";
import { messages } from "../../src/Feature.ts";
import { Outbound, OutboundDeliveryError, type OutboundRequest } from "../../src/Outbound.ts";
import { PaykitHandlers, PaykitModel } from "../../src/Paykit.model.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { Subscription } from "../../src/Subscription/Subscription.aggregate.ts";
import { tier } from "../../src/Tier.ts";

const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2_000 })],
});

const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [proTier] }));
const pro = allowancesOf(testCatalog, "pro")!;
const secret = "whsec_outbound_test";
const endpoint = { url: "https://app.example/hooks/paykit", secret: Redacted.make(secret) };
const account = "acct_outbound";

const world = (outbound: Layer.Layer<Outbound>) =>
  PaykitModel.layer(
    PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore), Layer.provide(outbound)),
  ).pipe(
    Layer.provide(Domain.InMemory),
    Layer.provideMerge(MemoryBillingReadStore),
    Layer.provideMerge(
      Layer.mergeAll(Layer.succeed(Actor, system("test")), catalogLayer(testCatalog), outbound),
    ),
  );

const transport = (
  requests: Array<OutboundRequest>,
  options: {
    readonly failFirst?: boolean;
    readonly endpoints?: ReadonlyArray<typeof endpoint>;
  } = {},
): Layer.Layer<Outbound> => {
  let attempts = 0;

  return Layer.succeed(Outbound, {
    endpoints: options.endpoints ?? [endpoint],
    deliver: (request) =>
      Effect.suspend(() => {
        attempts++;

        if (options.failFirst === true && attempts === 1) {
          return Effect.fail(
            new OutboundDeliveryError({ endpoint: request.endpoint.url, reason: "temporary" }),
          );
        }

        requests.push(request);

        return Effect.void;
      }),
  });
};

const subscribe = Effect.gen(function* () {
  const subscription = yield* Subscription;

  return yield* subscription.send(
    Subscription.ref(account),
    new Subscribe({
      tier: "pro",
      allowances: pro,
      price: { amount: 1900, currency: "usd", interval: "month" },
      credits: 0,
      creditsExpire: "period",
      rates: {},
    }),
  );
});

const waitFor = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (done()) return;
      yield* Effect.sleep("5 millis");
    }
  });

const verify = (request: OutboundRequest): boolean => {
  const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(request.headers["x-paykit-signature"] ?? "");

  if (match === null) return false;

  const tag = new Bun.CryptoHasher("sha256", new TextEncoder().encode(secret))
    .update(`${match[1]}.${request.body}`)
    .digest("hex");

  return tag === match[2];
};

describe("outbound events", () => {
  it.live("signs and sends every committed event once per endpoint", () => {
    const requests: Array<OutboundRequest> = [];

    return Effect.gen(function* () {
      yield* subscribe;
      yield* waitFor(() => requests.length > 0);
      expect(requests.length).toBe(1);

      const request = requests[0]!;
      expect(request.endpoint.url).toBe(endpoint.url);
      expect(request.idempotencyKey).toBe(`acct_outbound:1`);
      expect(request.headers["x-paykit-event"]).toBe("SubscriptionActivated");

      if (!verify(request)) throw new Error("the outbound signature did not verify");

      const body = JSON.parse(request.body) as {
        account: string;
        event: { _tag: string };
        envelope: { seq: number };
      };

      expect(body.account).toBe(account);
      expect(body.event._tag).toBe("SubscriptionActivated");
      expect(body.envelope.seq).toBe(1);
    }).pipe(Effect.provide(world(transport(requests))));
  });

  it.live("retries a refused transport with the same idempotency key", () => {
    const requests: Array<OutboundRequest> = [];

    return Effect.gen(function* () {
      yield* subscribe;
      yield* waitFor(() => requests.length > 0);
      expect(requests.length).toBeGreaterThanOrEqual(1);
      expect(verify(requests[0]!)).toBe(true);
      expect(requests[0]!.idempotencyKey).toBe("acct_outbound:1");
    }).pipe(Effect.provide(world(transport(requests, { failFirst: true }))));
  });

  it.live("a deployment with no Outbound layer is a no-op", () =>
    Effect.gen(function* () {
      yield* subscribe;
      yield* Effect.sleep("20 millis");
    }).pipe(
      Effect.provide(
        PaykitModel.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore))).pipe(
          Layer.provide(Domain.InMemory),
          Layer.provideMerge(MemoryBillingReadStore),
          Layer.provideMerge(
            Layer.mergeAll(Layer.succeed(Actor, system("test")), catalogLayer(testCatalog)),
          ),
        ),
      ),
    ),
  );
});
