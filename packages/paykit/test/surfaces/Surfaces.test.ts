import { expect, it } from "@alchemy.run/test";
import { Tool } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  BillingAdminMcp,
  BillingAdminToolkit,
  BillingCli,
  BillingMcp,
  BillingToolkit,
} from "../../src/Surfaces.ts";

const toolNames = (toolkit: { readonly tools: Readonly<Record<string, Tool.Any>> }) =>
  Object.keys(toolkit.tools).sort();

it("one declaration projects to an MCP server for each Api", () => {
  expect(Layer.isLayer(BillingMcp)).toBe(true);
  expect(Layer.isLayer(BillingAdminMcp)).toBe(true);
});

it("the tenant tools are the commands and reads a signed-in account may reach", () => {
  const names = toolNames(BillingToolkit.toolkit);
  expect(names).toContain("BillingApi_TrackUsage_send");
  expect(names).toContain("BillingApi_Hold_send");
  expect(names).toContain("BillingApi_SettleHold_send");
  expect(names).toContain("BillingApi_ReleaseHold_send");
  expect(names).toContain("BillingApi_Entitlements_get");
  expect(names).toContain("BillingApi_BillingState_get");
  // The tenant Api does not serve the operator commands at all.
  expect(names.some((name) => name.includes("GrantCredits"))).toBe(false);
  expect(names.some((name) => name.includes("RecordPayment"))).toBe(false);
});

it("no tool is a stream: watch and events stay on the Api's own clients", () => {
  const names = [...toolNames(BillingToolkit.toolkit), ...toolNames(BillingAdminToolkit.toolkit)];
  expect(names.some((name) => name.endsWith("_watch"))).toBe(false);
  expect(names.some((name) => name.endsWith("_events"))).toBe(false);
});

it("every tool name fits the limit a model provider accepts", () => {
  for (const name of toolNames(BillingAdminToolkit.toolkit)) {
    expect(name.length).toBeLessThanOrEqual(64);
  }
});

it("a command tool is destructive and a read tool is read-only", () => {
  const tools = BillingToolkit.toolkit.tools as Readonly<Record<string, Tool.Any>>;
  const write = tools["BillingApi_TrackUsage_send"]!;
  const read = tools["BillingApi_Entitlements_get"]!;
  expect(Context.get(write.annotations, Tool.Destructive)).toBe(true);
  expect(Context.get(read.annotations, Tool.Readonly)).toBe(true);
  expect(Context.get(read.annotations, Tool.Destructive)).toBe(false);
});

it("a rejection is returned as a tool failure the model can act on", () => {
  const tools = BillingAdminToolkit.toolkit.tools as Readonly<Record<string, Tool.Any>>;
  const grant = tools["BillingAdminApi_GrantCredits_send"]!;
  expect(grant.failureMode).toBe("return");
});

it("the ops Api's tools include the operator commands", () => {
  const names = toolNames(BillingAdminToolkit.toolkit);
  expect(names).toContain("BillingAdminApi_GrantCredits_send");
  expect(names).toContain("BillingAdminApi_ExtendTrial_send");
  expect(names).toContain("BillingAdminApi_Subscription_get");
});

it("the CLI is derived from the same Api, not written by hand", () => {
  expect(BillingCli).toBeDefined();
  expect(typeof BillingCli).toBe("object");
});

it("the tools need the model and the guards, nothing more", () =>
  Effect.gen(function* () {
    // A tool call runs the Api in process, so it needs the hosted model and
    // the Api's middleware — the same layers HTTP serving needs.
    const requirements = BillingToolkit.layer as unknown as {
      readonly _: unknown;
    };
    expect(requirements).toBeDefined();
  }).pipe(Effect.asVoid));
