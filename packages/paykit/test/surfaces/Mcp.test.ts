import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import { McpProtocol, McpServer } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import {
  Actor,
  allowance,
  allowancesOf,
  catalog,
  CatalogGuardLive,
  catalogLayer,
  DevGuards,
  MemoryBillingReadStore,
  messages,
  Model,
  PaykitHandlers,
  Subscription,
  system,
  tier,
} from "../../src/index.ts";
import { BillingMcp } from "../../src/Surfaces.ts";

const freeTier = tier({ id: "free", grants: [allowance(messages, { included: 100 })] });
const proTier = tier({
  id: "pro",
  price: { amount: 1900, currency: "usd", interval: "month" },
  grants: [allowance(messages, { included: 2000, overage: "bill" })],
});
const testCatalog = Effect.runSync(catalog({ features: [messages], tiers: [freeTier, proTier] }));
const free = allowancesOf(testCatalog, "free")!;

const account = Subscription.ref("acct_mcp");

const World = Layer.orDie(
  Layer.mergeAll(
    DevGuards,
    CatalogGuardLive.pipe(Layer.provideMerge(catalogLayer(testCatalog))),
  ).pipe(
    Layer.provideMerge(Model.layer(PaykitHandlers.pipe(Layer.provide(MemoryBillingReadStore)))),
    Layer.provideMerge(MemoryBillingReadStore),
    Layer.provideMerge(Layer.succeed(Actor, system("test"))),
    Layer.provide(Domain.InMemory),
  ),
);

/** An MCP client over the server's web handler, in process. */
const mcpClient = (handler: (request: Request) => Promise<Response>) => {
  let session: string | undefined;
  let id = 0;
  const post = Effect.fn(function* (body: object, headers: Record<string, string> = {}) {
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
            ...(session ? { "mcp-session-id": session } : {}),
            ...headers,
          },
          body: JSON.stringify({ jsonrpc: "2.0", ...body }),
        }),
      ),
    );
    session ??= response.headers.get("mcp-session-id") ?? undefined;
    const text = yield* Effect.promise(() => response.text());
    return text === "" ? undefined : (JSON.parse(text) as { result?: any; error?: any });
  });
  const request = (method: string, params: object, headers?: Record<string, string>) =>
    post({ id: ++id, method, params }, headers);
  const connect = Effect.gen(function* () {
    yield* request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    yield* post({ method: "notifications/initialized" });
  });
  return { connect, request };
};

const withMcp = <A, E>(effect: Effect.Effect<A, E, McpHandler>) =>
  Effect.gen(function* () {
    // The MCP server is the Api: the same model, the same guards, no second
    // declaration. Its layers are the Api's, provided once.
    const { handler, dispose } = HttpRouter.toWebHandler(
      BillingMcp.pipe(
        Layer.provide(
          McpServer.layerHttp({
            name: "paykit",
            version: "0.1.0",
            path: "/mcp",
            protocols: [McpProtocol.v2025_11_25],
          }),
        ),
        Layer.provide(World),
      ),
      { disableLogger: true },
    );
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    return yield* effect.pipe(Effect.provideService(McpHandler, handler));
  }).pipe(Effect.scoped) as Effect.Effect<A, E, never>;

/** The MCP server's web handler, put in scope by `withMcp`. */
class McpHandler extends Context.Service<McpHandler, (request: Request) => Promise<Response>>()(
  "paykit-test/McpHandler",
) {}

describe("the MCP surface", () => {
  it.live("a tool call authenticates as the caller and commits a real command", () =>
    Effect.gen(function* () {
      const mcp = mcpClient(yield* McpHandler);
      yield* mcp.connect;

      const planted = yield* mcp.request(
        "tools/call",
        {
          name: "BillingApi_Subscribe_send",
          arguments: { target: account.id, input: { tier: "free", allowances: free } },
        },
        { "x-paykit-actor": account.id },
      );
      expect(planted!.result.isError).toBe(false);

      const tracked = yield* mcp.request(
        "tools/call",
        {
          name: "BillingApi_TrackUsage_send",
          arguments: { target: account.id, input: { feature: "messages", amount: 7 } },
        },
        { "x-paykit-actor": account.id },
      );
      expect(tracked!.result.isError).toBe(false);

      const read = yield* mcp.request(
        "tools/call",
        { name: "BillingApi_Entitlements_get", arguments: { key: account.id } },
        { "x-paykit-actor": account.id },
      );
      expect(read!.result.isError).toBe(false);
      expect(read!.result.structuredContent.value.features.messages.used).toBe(7);
    }).pipe(withMcp),
  );

  it.live("a tool call with no caller is refused with the Api's own rejection", () =>
    Effect.gen(function* () {
      const mcp = mcpClient(yield* McpHandler);
      yield* mcp.connect;
      const refused = yield* mcp.request("tools/call", {
        name: "BillingApi_TrackUsage_send",
        arguments: { target: account.id, input: { feature: "messages", amount: 1 } },
      });
      expect(refused!.result.isError).toBe(true);
      expect(JSON.parse(refused!.result.content[0].text)).toMatchObject({
        _tag: "Unauthenticated",
      });
    }).pipe(withMcp),
  );

  it.live("a tool cannot act on another account", () =>
    Effect.gen(function* () {
      const mcp = mcpClient(yield* McpHandler);
      yield* mcp.connect;
      const refused = yield* mcp.request(
        "tools/call",
        {
          name: "BillingApi_TrackUsage_send",
          arguments: {
            target: Subscription.ref("acct_someone_else").id,
            input: { feature: "messages", amount: 1 },
          },
        },
        { "x-paykit-actor": account.id },
      );
      expect(refused!.result.isError).toBe(true);
      expect(JSON.parse(refused!.result.content[0].text)).toMatchObject({ _tag: "Forbidden" });
    }).pipe(withMcp),
  );

  it.live("the tool list is the tenant Api, with no operator commands", () =>
    Effect.gen(function* () {
      const mcp = mcpClient(yield* McpHandler);
      yield* mcp.connect;
      const listed = yield* mcp.request("tools/list", {});
      const names = (listed!.result.tools as ReadonlyArray<{ name: string }>).map(
        (tool) => tool.name,
      );
      expect(names).toContain("BillingApi_TrackUsage_send");
      expect(names).toContain("BillingApi_ReserveUsage_send");
      expect(names.some((name) => name.includes("GrantCredits"))).toBe(false);
      expect(names.some((name) => name.endsWith("_watch"))).toBe(false);
    }).pipe(withMcp),
  );

  it.live("a preview is not a tool, so an agent cannot see a charge before it applies it", () =>
    Effect.gen(function* () {
      const mcp = mcpClient(yield* McpHandler);
      yield* mcp.connect;
      const listed = yield* mcp.request("tools/list", {});
      const names = (listed!.result.tools as ReadonlyArray<{ name: string }>).map(
        (tool) => tool.name,
      );
      // `Preview` is a binding, not an Api command, so it is not reachable.
      expect(names.some((name) => name.toLowerCase().includes("preview"))).toBe(false);
    }).pipe(withMcp),
  );
});
