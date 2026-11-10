import { describe, expect, it } from "@alchemy.run/test";
import { Paykit } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import { SaasLive } from "../src/Billing.layer.ts";
import { conversations, pro } from "../src/catalog.ts";
import { project, Workspace } from "../src/Workspace.ts";
import { account, activate } from "./support.ts";

describe("projects are scopes, not customers", () => {
  it.live(
    "a grant, a transfer and an archive move one project's units, never the shared pool",
    () =>
      Effect.gen(function* () {
        yield* activate(pro);

        const workspace = yield* Workspace(account.id);
        const docs = yield* workspace.create(project("proj_docs"), "Docs");
        const scraper = yield* workspace.create(project("proj_scraper"), "Scraper");

        // With no plan of its own, a project draws the org's one shared source.
        const before = yield* workspace.conversations(docs.id);
        expect(before.remaining).toBe(2_000);
        expect(before.breakdown.filter((row) => row.pooled === true)).toHaveLength(1);

        // A grant is the project's own source, on top of the shared pool.
        const granted = yield* workspace.grant(docs.id, 500, "grant-docs-1");
        expect(granted.remaining).toBe(2_500);

        // The scraper gets a plan of its own: the add-on, stacked beside the
        // group's plan and scoped to that project.
        yield* workspace.addStudio(scraper.id, "studio-scraper-1");

        // A transfer moves own units between siblings, and never touches the pool.
        yield* workspace.transfer(docs.id, scraper.id, 100, "transfer-docs-scraper-1");

        const moved = yield* workspace.conversations(docs.id);
        expect(moved.remaining).toBe(2_400);

        // 450 spent: 400 of the project's own, then 50 from the shared pool.
        const track = yield* Paykit.TrackUsage(account.id);
        yield* track({
          featureId: conversations.id,
          entityId: docs.id,
          value: 450,
          idempotencyKey: "docs-450",
        });

        const after = yield* workspace.conversations(docs.id);
        expect(after.remaining).toBe(1_950);
        expect(after.breakdown.find((row) => row.pooled === true)?.remaining).toBe(1_950);

        // A project with people in seats cannot be archived: evicting them is
        // never a billing side effect (ADR 0040 §7).
        yield* workspace.occupy(scraper.id, 1, "scraper-seats-1");
        const refused = yield* Effect.flip(workspace.archive(scraper.id, "archive-scraper-1"));
        expect(refused._tag).toBe("EntityHasOccupancy");

        yield* workspace.occupy(scraper.id, 0, "scraper-seats-0");
        const archived = yield* workspace.archive(scraper.id, "archive-scraper-1");
        expect(archived.status).toBe("archived");
        expect(archived.archivedAt).toBeDefined();

        // Archiving swept the project's own 600 units back to the org, so the
        // organization holds the pool and the returned grant.
        const balances = yield* Paykit.Balances(account.id);
        const org = yield* balances.get({ featureId: conversations.id });

        expect(org.remaining).toBe(2_550);

        // The list keeps the archived project: a bill still references it.
        const projects = yield* workspace.list();
        expect(projects.map((entry) => entry.status).sort()).toEqual(["archived", "attached"]);
      }).pipe(Effect.provide(SaasLive)),
  );

  it.live("refuses a transfer into an archived project", () =>
    Effect.gen(function* () {
      yield* activate(pro);

      const workspace = yield* Workspace(account.id);
      const docs = yield* workspace.create(project("proj_docs"), "Docs");
      const gone = yield* workspace.create(project("proj_gone"), "Gone");

      yield* workspace.grant(docs.id, 100, "grant-docs-1");
      yield* workspace.archive(gone.id, "archive-gone-1");

      const refused = yield* Effect.flip(
        workspace.transfer(docs.id, gone.id, 10, "transfer-gone-1"),
      );

      expect(refused._tag).toBe("EntityArchived");
    }).pipe(Effect.provide(SaasLive)),
  );
});
