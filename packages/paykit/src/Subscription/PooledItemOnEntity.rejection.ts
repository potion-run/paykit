import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { EntityId } from "../Customer.ts";

/**
 * A `pooled: true` plan item was attached on an entity. A pooled item's grant
 * belongs to the parent and is one source every entity draws on; attaching one
 * on an entity would be a second pool (ADR 0040 §3).
 */
export class PooledItemOnEntity extends Domain.Rejection("PooledItemOnEntity", {
  entityId: EntityId,
  planId: Schema.String,
  feature: Schema.String,
}) {}
