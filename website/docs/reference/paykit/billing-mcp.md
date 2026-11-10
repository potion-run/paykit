---
title: "BillingMcp"
description: "The surfaces an Api projects onto, without a second declaration."
---

> **Source:** [`packages/paykit/src/Surfaces.ts`](https://github.com/potion-run/paykit/blob/main/packages/paykit/src/Surfaces.ts#L6)
> **Kind:** Layer

The surfaces an Api projects onto, without a second declaration.

This module is a separate entry point (`@potion.run/paykit/Surfaces`)
because it loads `effect/ai` and `effect/cli`. An app that serves only HTTP
never imports it, and never pays for them.

An Api is the unit of authorization: `toMcp` runs every tool call through
the Api's own middleware, using the MCP request's headers, so the tenant MCP
server authenticates exactly as the tenant HTTP surface does. Serve the two
Apis at two paths; never merge them.

## Serving tools to an agent

```typescript
import { McpProtocol, McpServer } from "effect/ai";
import * as HttpRouter from "effect/http/HttpRouter";
import { BillingMcp } from "@potion.run/paykit/Surfaces";
import { BillingLive } from "./Billing.ts";

const Mcp = BillingMcp.pipe(
  Layer.provide(
    McpServer.layerHttp({ name: "billing", version: "1.0.0", path: "/mcp", protocols: [McpProtocol.v2025_11_25] }),
  ),
  Layer.provide(BillingLive),
);

export const { handler } = HttpRouter.toWebHandler(Mcp);
```
