import { describe, expect, it } from "@alchemy.run/test";
import { BillingState, Paykit } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { answering, setGuardrails } from "../src/Agent.ts";
import { SaasLive } from "../src/Billing.layer.ts";
import { conversations, pro } from "../src/catalog.ts";
import { project, Workspace } from "../src/Workspace.ts";
import { account, activate, entitlementsOf } from "./support.ts";

/** One account's billing page, for the evidence a spend records. */
const billingPage = Effect.gen(function* () {
  const billing = yield* BillingState;

  return Option.getOrNull(yield* billing.query(account));
});

describe("one metered turn", () => {
  it.live("records the conversation and the credits, and replays both on a retry", () =>
    Effect.gen(function* () {
      yield* activate(pro);

      const workspace = yield* Workspace(account.id);
      const docs = yield* workspace.create(project("proj_docs"), "Docs");
      const { answer } = yield* answering;

      const first = yield* answer(account.id, {
        project: docs.id,
        model: "default",
        requestId: "turn-1",
      });

      expect(first.reply).toContain("turn-1");
      expect(first.remaining).toBe(1_999);
      expect(first.credits).toBe(4_999);

      // The retry key is the caller's: the same request records one
      // conversation and one credit spend, and answers the state it left.
      const retried = yield* answer(account.id, {
        project: docs.id,
        model: "default",
        requestId: "turn-1",
      });

      expect(retried.remaining).toBe(1_999);
      expect(retried.credits).toBe(4_999);

      // The large model costs ten credits, from the same one pool.
      const large = yield* answer(account.id, {
        project: docs.id,
        model: "gpt-large",
        requestId: "turn-2",
      });

      expect(large.credits).toBe(4_989);

      const used = yield* workspace.conversations(docs.id);
      expect(used.remaining).toBe(1_998);
    }).pipe(Effect.provide(SaasLive)),
  );

  it.live("pages the organization once when usage reaches the threshold it set", () =>
    Effect.gen(function* () {
      yield* activate(pro);
      yield* setGuardrails(account.id, { alertAt: 2 });

      const workspace = yield* Workspace(account.id);
      const docs = yield* workspace.create(project("proj_docs"), "Docs");
      const { answer } = yield* answering;

      yield* answer(account.id, { project: docs.id, model: "default", requestId: "alert-1" });
      yield* answer(account.id, { project: docs.id, model: "default", requestId: "alert-2" });

      // One row per threshold, recorded as evidence and never as a refusal.
      const page = yield* billingPage;
      expect(page?.alertsFired?.map((alert) => alert.at)).toEqual([2]);

      // A spend past the same threshold does not fire it again this period.
      yield* answer(account.id, { project: docs.id, model: "default", requestId: "alert-3" });
      expect((yield* billingPage)?.alertsFired?.length).toBe(1);
    }).pipe(Effect.provide(SaasLive)),
  );

  it.live("refuses the next turn at the organization's overage ceiling, before recording it", () =>
    Effect.gen(function* () {
      yield* activate(pro);
      yield* setGuardrails(account.id, { monthlyCeiling: 100 });

      const { answer } = yield* answering;

      // Fifty conversations past the included 2,000 bill the whole $1.00
      // ceiling: two cents each, in minor units. A turn without a project is
      // the organization's own scope, where the plan's billed overage is judged.
      const track = yield* Paykit.TrackUsage(account.id);
      yield* track({
        featureId: conversations.id,
        value: 2_050,
        idempotencyKey: "fill-the-ceiling",
      });

      const before = yield* entitlementsOf;

      const refused = yield* Effect.flip(
        answer(account.id, { model: "default", requestId: "turn-over" }),
      );

      expect(refused._tag).toBe("AgentRefused");
      expect(refused._tag === "AgentRefused" ? refused.reason : null).toBe("spend_limit");

      // The refusal recorded nothing: the work did not happen, so neither did
      // the usage fact and the credit spend.
      const after = yield* entitlementsOf;
      expect(after?.features[conversations.id]?.used).toBe(
        before?.features[conversations.id]?.used,
      );
      expect(after?.credits).toBe(before?.credits);
    }).pipe(Effect.provide(SaasLive)),
  );

  it.live("refuses a turn the credit pool cannot pay for, before recording the conversation", () =>
    Effect.gen(function* () {
      yield* activate(pro);

      const workspace = yield* Workspace(account.id);
      const docs = yield* workspace.create(project("proj_docs"), "Docs");
      const { answer } = yield* answering;

      // Spend the pool down to four credits, below the large model's ten.
      const consume = yield* Paykit.ConsumeCredits(account.id);
      yield* consume({ amount: 4_996, dedupeKey: "drain-the-pool" });

      const refused = yield* Effect.flip(
        answer(account.id, { project: docs.id, model: "gpt-large", requestId: "turn-broke" }),
      );

      expect(refused._tag).toBe("AgentRefused");
      expect(refused._tag === "AgentRefused" ? refused.reason : null).toBe("credits");

      const used = yield* entitlementsOf;
      expect(used?.features[conversations.id]?.used ?? 0).toBe(0);
      expect(used?.credits).toBe(4);
    }).pipe(Effect.provide(SaasLive)),
  );
});
