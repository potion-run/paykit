import { describe, expect, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import { PreviewAnswer, previewAnswerOf } from "../../src/Admin/Reads.ts";
import type { PreviewResult } from "../../src/Billing/Preview.operation.ts";
import { planTermsOf } from "../../src/Catalog.ts";
import { AlreadyCanceled } from "../../src/Subscription/AlreadyCanceled.rejection.ts";
import { NotSubscribed } from "../../src/Subscription/NotSubscribed.rejection.ts";
import { PlanNotInCatalog } from "../../src/Subscription/PlanNotInCatalog.rejection.ts";
import { ScheduleCancellation } from "../../src/Subscription/ScheduleCancellation.command.ts";
import { Subscribe } from "../../src/Subscription/Subscribe.command.ts";
import { initialSubscriptionState } from "../../src/Subscription/Subscription.state.ts";
import { assertProperty } from "../support/Property.ts";
import {
  TierName,
  canonical,
  commandOf,
  decideAt,
  evolveAt,
  isAccepted,
  prorationFor,
  start,
  subscribedIn,
  testCatalog,
} from "./Arbitraries.ts";

const AnswerCodec = Schema.toCodecJson(PreviewAnswer);

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** An answer is wire-safe when its encoding survives a round trip unchanged. */
const wireStable = (answer: PreviewAnswer): boolean => {
  const wire = Schema.encodeSync(AnswerCodec)(answer);
  const decoded = Schema.decodeSync(AnswerCodec)(wire);

  return (
    same(Schema.encodeSync(AnswerCodec)(decoded), wire) &&
    same(JSON.parse(JSON.stringify(wire)), wire)
  );
};

const Move = Schema.Struct({
  kind: Schema.Literals(["subscribe", "changeTier", "cancel"]),
  startTier: TierName,
  nextTier: TierName,
});

type Move = typeof Move.Type;

/** The result the in-process preview would hand the console for one move. */
const acceptedPreview = (move: Move): PreviewResult | null => {
  const state =
    move.kind === "subscribe"
      ? initialSubscriptionState
      : subscribedIn(testCatalog, move.startTier);

  const terms = planTermsOf(testCatalog, move.startTier);

  if (terms === null) return null;

  const command =
    move.kind === "subscribe"
      ? new Subscribe({ tier: move.startTier, ...terms })
      : move.kind === "cancel"
        ? new ScheduleCancellation()
        : commandOf({ _tag: "ChangeTier", tier: move.nextTier }, state, start);

  const decision = decideAt(state, command, start, "preview-answer");

  if (!isAccepted(decision) || decision.length === 0) return null;

  const proration =
    move.kind === "changeTier" ? prorationFor(state, move.nextTier, start) : undefined;

  return {
    _tag: "accepted",
    state: evolveAt(state, decision, start, "preview-answer"),
    events: decision,
    ...(proration === undefined ? {} : { proration }),
  };
};

const RejectionTag = Schema.Literals(["PlanNotInCatalog", "NotSubscribed", "AlreadyCanceled"]);

const rejected = (tag: typeof RejectionTag.Type): PreviewResult => {
  switch (tag) {
    case "PlanNotInCatalog":
      return { _tag: "rejected", rejection: new PlanNotInCatalog({ tier: "gold" }) };
    case "NotSubscribed":
      return { _tag: "rejected", rejection: new NotSubscribed({ account: "acct_1" }) };
    case "AlreadyCanceled":
      return { _tag: "rejected", rejection: new AlreadyCanceled() };
  }
};

describe("the console preview answer", () => {
  it.effect("keeps an accepted preview's state, events and proration, and crosses the wire", () =>
    assertProperty(Arbitrary.schema(Move), (move) => {
      const result = acceptedPreview(move);

      // A generated move the model refuses has no accepted preview; the
      // rejection path is the next property's job.
      if (result === null || result._tag !== "accepted") return true;

      const answer = previewAnswerOf(result);

      if (answer._tag !== "accepted") return false;

      if (!same(canonical(answer.state), canonical(result.state))) return false;

      if (
        !same(
          answer.events.map((event) => event._tag),
          result.events.map((event) => event._tag),
        )
      )
        return false;

      if (!same(answer.proration, result.proration)) return false;

      return wireStable(answer);
    }),
  );

  it.effect("keeps a rejection the console can display, and crosses the wire", () =>
    assertProperty(Arbitrary.schema(RejectionTag), (tag) => {
      const answer = previewAnswerOf(rejected(tag));

      if (answer._tag !== "rejected") return false;

      return answer.rejection._tag === tag && wireStable(answer);
    }),
  );

  it.effect("refuses to call an accepted preview whose events it cannot display", () =>
    assertProperty(Arbitrary.schema(TierName), (tier) => {
      const state = subscribedIn(testCatalog, tier);

      const answer = previewAnswerOf({
        _tag: "accepted",
        state,
        events: [{ _tag: "UsageRecorded" }],
      });

      return answer._tag === "unpredictable" && wireStable(answer);
    }),
  );

  it("turns a rejection it cannot display, and a decision it never made, into unpredictable", () => {
    const unknown = previewAnswerOf({
      _tag: "rejected",
      rejection: { _tag: "ModelAddedARejection" },
    });

    expect(unknown._tag).toBe("unpredictable");

    const undecided = previewAnswerOf({
      _tag: "unpredictable",
      cause: new Error("the wallet is closed"),
    });

    expect(undecided._tag).toBe("unpredictable");
  });
});
