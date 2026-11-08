import { describe, expect, it } from "@alchemy.run/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  AdminReadFailed,
  AdminReads,
  type AdminReadsShape,
  BillingOverview,
  PreviewUnpredictable,
  ProviderRefsAnswer,
} from "../../src/Admin/Reads.ts";
import { AdminQueries, BillingAdmin } from "../../src/Foldkit.ts";

const reads = (overrides: Partial<AdminReadsShape> = {}): AdminReadsShape => ({
  list: () => Effect.succeed({ rows: [], next: null }),
  preview: () => Effect.die("unused"),
  verify: () => Effect.die("unused"),
  holds: () => Effect.die("unused"),
  providerRefs: () => Effect.die("unused"),
  overview: () => Effect.die("unused"),
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

  it.effect("reports provider refs with the request they answer", () =>
    Effect.gen(function* () {
      const message = yield* AdminQueries.ProviderRefs({
        requestId: 10,
        account: "acct_1",
      }).effect.pipe(
        Effect.provideService(
          AdminReads,
          reads({
            providerRefs: (account) =>
              Effect.succeed(
                ProviderRefsAnswer.make({
                  account,
                  refs: { manual: { customer: "cus_1" } },
                  asOf: DateTime.makeUnsafe(0),
                }),
              ),
          }),
        ),
      );

      expect(message._tag).toBe("SucceededProviderRefs");

      if (message._tag !== "SucceededProviderRefs") return;
      expect(message.requestId).toBe(10);
      expect(message.answer.refs.manual?.customer).toBe("cus_1");
    }),
  );

  it.effect("reports the cross-account overview", () =>
    Effect.gen(function* () {
      const overview = BillingOverview.make({
        asOf: DateTime.makeUnsafe(0),
        accounts: 2,
        byStatus: [],
        byStanding: [],
        byTier: [],
        revenue: [],
      });

      const message = yield* AdminQueries.Overview({ requestId: 11 }).effect.pipe(
        Effect.provideService(AdminReads, reads({ overview: () => Effect.succeed(overview) })),
      );

      expect(message._tag).toBe("SucceededOverview");

      if (message._tag !== "SucceededOverview") return;
      expect(message.requestId).toBe(11);
      expect(message.overview.accounts).toBe(2);
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
