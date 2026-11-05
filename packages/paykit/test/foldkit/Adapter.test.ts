import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import {
  AdminReadFailed,
  AdminReads,
  type AdminReadsShape,
  PreviewUnpredictable,
} from "../../src/Admin/Reads.ts";
import { AdminQueries, BillingAdmin } from "../../src/Foldkit.ts";

const reads = (overrides: Partial<AdminReadsShape> = {}): AdminReadsShape => ({
  list: () => Effect.succeed({ rows: [], next: null }),
  preview: () => Effect.die("unused"),
  verify: () => Effect.die("unused"),
  holds: () => Effect.die("unused"),
  catalog: () => Effect.die("unused"),
  ...overrides,
});

describe("the Foldkit adapter", () => {
  it("derives one Command and one result per admin Api command", () => {
    expect(typeof BillingAdmin.GrantCredits).toBe("function");
    expect(typeof BillingAdmin.ChangeTier).toBe("function");
    expect(BillingAdmin.Message.SucceededGrantCredits).toBeDefined();
    expect(BillingAdmin.Message.FailedChangeTier).toBeDefined();
  });

  it.effect("reports a list page with the request it answers", () =>
    Effect.gen(function* () {
      const message = yield* AdminQueries.ListAccounts({
        requestId: 7,
        query: {},
      }).effect.pipe(Effect.provideService(AdminReads, reads()));
      expect(message._tag).toBe("SucceededListAccounts");
      if (message._tag !== "SucceededListAccounts") return;
      expect(message.requestId).toBe(7);
      expect(message.page.rows).toEqual([]);
    }),
  );

  it.effect("reports a read failure as a result the console can render", () =>
    Effect.gen(function* () {
      const message = yield* AdminQueries.ListAccounts({
        requestId: 8,
        query: {},
      }).effect.pipe(
        Effect.provideService(
          AdminReads,
          reads({
            list: () => Effect.fail(new AdminReadFailed({ reason: "offline", message: "offline" })),
          }),
        ),
      );
      expect(message._tag).toBe("FailedListAccounts");
      if (message._tag !== "FailedListAccounts") return;
      expect(message.error._tag).toBe("AdminReadFailed");
    }),
  );

  it.effect("reports a preview answer without pretending it is a write", () =>
    Effect.gen(function* () {
      const message = yield* AdminQueries.Preview({
        requestId: 9,
        input: { account: "acct_1", command: { kind: "cancel" } },
      }).effect.pipe(
        Effect.provideService(
          AdminReads,
          reads({
            preview: () =>
              Effect.succeed(PreviewUnpredictable.make({ reason: "the model could not decide" })),
          }),
        ),
      );
      expect(message._tag).toBe("SucceededPreview");
      if (message._tag !== "SucceededPreview") return;
      expect(message.answer._tag).toBe("unpredictable");
    }),
  );
});
