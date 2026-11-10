import { describe, expect, it } from "@alchemy.run/test";
import { Paykit } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import { SaasLive } from "../src/Billing.layer.ts";
import { conversations, free, seats } from "../src/catalog.ts";
import { project, Workspace } from "../src/Workspace.ts";
import { account } from "./support.ts";

describe("signing an organization up", () => {
  it.live("records the org, activates the free plan, and answers a check locally", () =>
    Effect.gen(function* () {
      const customers = yield* Paykit.Customers(account.id);

      // `getOrCreate` is the sign-up path: an existing customer is answered
      // untouched, so a retried sign-up can never rewrite the organization.
      const org = yield* customers.getOrCreate({
        name: "Acme Support",
        email: "ops@acme.test",
      });

      expect(org.name).toBe("Acme Support");
      expect(org.plans).toEqual([]);

      // A free plan activates without a provider call. The answer is the plan
      // operation's own outcome, not a second shape this example invented.
      const attach = yield* Paykit.Attach(account.id);
      const bought = yield* attach({ planId: free.id, idempotencyKey: "signup-acme-1" });

      expect(bought.outcome).toBe("activated");
      expect(bought.planId).toBe(free.id);

      const check = yield* Paykit.Check(account.id);
      const answer = yield* check({ featureId: conversations.id, requiredBalance: 1 });

      expect(answer.allowed).toBe(true);
      expect(answer.standing).toBe("good");
      expect(answer.balance.remaining).toBe(100);

      // The free plan includes one seat; an organization of ten cannot use ten.
      const seat = yield* check({ featureId: seats.id, requiredBalance: 10 });
      expect(seat.allowed).toBe(false);
    }).pipe(Effect.provide(SaasLive)),
  );

  it.live("refuses a second identity for a customer that already recorded one", () =>
    Effect.gen(function* () {
      const customers = yield* Paykit.Customers(account.id);

      yield* customers.create({ name: "Acme Support", email: "ops@acme.test" });

      // The same details are a no-op; a different identity is a refusal, so
      // two sign-ups cannot fight over one billing account (ADR 0045).
      yield* customers.create({ name: "Acme Support", email: "ops@acme.test" });

      const refused = yield* Effect.flip(
        customers.create({ name: "Globex", email: "billing@globex.test" }),
      );

      expect(refused._tag).toBe("CustomerExists");
    }).pipe(Effect.provide(SaasLive)),
  );

  it.live("opens a project once, even when the same request is retried", () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace(account.id);
      const docs = project("proj_docs");

      const first = yield* workspace.create(docs, "Docs");
      const retried = yield* workspace.create(docs, "Docs");

      expect(first.id).toBe("proj_docs");
      expect(retried.id).toBe("proj_docs");
      expect(retried.status).toBe("attached");
      expect((yield* workspace.list()).length).toBe(1);
    }).pipe(Effect.provide(SaasLive)),
  );
});
