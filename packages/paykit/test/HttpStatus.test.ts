import { expect, it } from "@alchemy.run/test";
import { httpStatus } from "../src/HttpStatus.ts";

it("maps a refusal to the status a caller can act on", () => {
  expect(httpStatus({ _tag: "PlanNotInCatalog" })).toBe(400);
  expect(httpStatus({ _tag: "WebhookInvalid" })).toBe(400);
  expect(httpStatus({ _tag: "NotSubscribed" })).toBe(400);
  expect(httpStatus({ _tag: "PlanOperationUnsupported" })).toBe(400);
  expect(httpStatus({ _tag: "Unauthenticated" })).toBe(401);
  expect(httpStatus({ _tag: "WebhookSignatureInvalid" })).toBe(401);
  expect(httpStatus({ _tag: "PaymentDeclined" })).toBe(402);
  expect(httpStatus({ _tag: "Forbidden" })).toBe(403);
  expect(httpStatus({ _tag: "ProviderCapabilityMissing" })).toBe(501);
});

it("fails closed on a tag it does not know", () => {
  expect(httpStatus({ _tag: "SomethingNew" })).toBe(500);
  expect(httpStatus({})).toBe(500);
});
