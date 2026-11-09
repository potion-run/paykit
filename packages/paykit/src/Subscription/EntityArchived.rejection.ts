import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { EntityId } from "../Customer.ts";

/**
 * The entity was archived, and an archive is terminal: it holds nothing, refuses
 * every write, and a second archive is this refusal rather than a replay of the
 * first (ADR 0040 §7). The event that recorded the archive has the same tag —
 * the class is `EntityArchivedEvent` — because the log's tag is what the ADR
 * names.
 */
export class EntityArchived extends Domain.Rejection("EntityArchived", {
  entityId: EntityId,
  /** When the archive happened, so an operator sees how long it has been closed. */
  archivedAt: Schema.DateTimeUtc,
}) {}
