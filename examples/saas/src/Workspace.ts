import { EntityId, Paykit } from "@potion.run/paykit";
import * as Effect from "effect/Effect";
import { conversations, seats, studio } from "./catalog.ts";

/**
 * The example's word for an entity: a project is a child scope under the
 * organization, not a second account. Its plans, grants and usage belong to the
 * org's one aggregate, and a read for it is a filtered read of the org's view
 * (ADR 0040 §1–3).
 */
export type Project = EntityId;

/**
 * Name a project by the id the organization already has for it.
 *
 * The id is the caller's, not generated here: `create` uses it as the command id
 * so a retry replays instead of creating a second project, and an id is never
 * reused after the project is archived (ADR 0040 §7).
 */
export const project = (id: string): Project => EntityId.make(id);

/**
 * One organization's projects, with the catalog in the types.
 *
 * A binding takes plain ids because the same binding is a wire contract. An app
 * imported `catalog.ts`, so this facade names the feature it grants, reads and
 * occupies once, and a call site cannot meter the wrong feature by string.
 *
 * ### A project, its grant, and its closure
 * **Example:** Give a project its own allowance, then archive it
 * ```typescript
 * const workspace = yield* Workspace(account);
 *
 * const scraper = yield* workspace.create(project("proj_scraper"), "Scraper");
 * yield* workspace.grant(scraper.id, 500, "grant-scraper-1");
 * const before = yield* workspace.conversations(scraper.id);
 *
 * // Archive is refused while the project has people in seats, so clear them first.
 * yield* workspace.occupy(scraper.id, 0, "seats-zero");
 * yield* workspace.archive(scraper.id, "archive-scraper-1");
 * ```
 *
 * @primitive
 */
export const Workspace = Effect.fn("Saas.Workspace")(function* (account: string) {
  const entities = yield* Paykit.Entities(account);
  const balances = yield* Paykit.Balances(account);
  const transfers = yield* Paykit.TransferBalance(account);
  const attach = yield* Paykit.Attach(account);

  return {
    /** Create a project. The id is the command id, so a retry replays. */
    create: (id: Project, name: string) => entities.create({ entityId: id, name }),

    /** Every project the org ever had, archived ones included, in id order. */
    list: () => entities.list(),

    /**
     * Give one project its own conversation allowance, above the shared pool.
     * A lifetime grant is a balance source, not a plan and not a purchase.
     */
    grant: (id: Project, amount: number, idempotencyKey: string) =>
      balances.create({
        featureId: conversations.id,
        entityId: id,
        grantedBalance: amount,
        reset: { interval: "one_off" },
        idempotencyKey,
      }),

    /** What one project may spend of conversations: its own rows plus the pool. */
    conversations: (id: Project) => balances.get({ featureId: conversations.id, entityId: id }),

    /**
     * Set how many seats one project occupies. This is usage, not a purchase, so
     * it never bills and never moves the quantity the org bought.
     */
    occupy: (id: Project, usage: number, idempotencyKey: string) =>
      balances.update({
        featureId: seats.id,
        entityId: id,
        usage,
        idempotencyKey,
      }),

    /**
     * Move a project's own conversation units to a sibling. A transfer moves own
     * sources only: it never borrows from the shared pool, and the total across
     * the org is conserved (ADR 0040 §5–6).
     */
    transfer: (from: Project, to: Project, amount: number, idempotencyKey: string) =>
      transfers({
        from: { kind: "entity", entityId: from },
        to: { kind: "entity", entityId: to },
        featureId: conversations.id,
        amount,
        idempotencyKey,
      }),

    /**
     * Stack the `studio` add-on beside one project's plan, so that project has
     * its own 500 conversations before the shared pool. An add-on never replaces
     * the plan it sits beside (ADR 0039 §2).
     */
    addStudio: (id: Project, idempotencyKey: string) =>
      attach({
        planId: studio.id,
        entityId: id,
        idempotencyKey,
      }),

    /**
     * Close a project. Refused while it has occupancy; when it succeeds the
     * command sweeps its unspent own sources to the org in the same event.
     */
    archive: (id: Project, idempotencyKey: string) =>
      entities.archive({ entityId: id, idempotencyKey }),

    /** One project's record, or `EntityUnknown`. */
    get: (id: Project) => entities.get(id),
  };
});
