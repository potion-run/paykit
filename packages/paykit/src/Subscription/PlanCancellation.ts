import * as Schema from "effect/Schema";
import { PlanRow as PlanRowSchema } from "./PlanSet.ts";

/** A group's planned cancellation: the plan it will resolve at the boundary. */
export const PlanCancellation = Schema.Struct({
  /** The plan the group holds now. */
  planId: Schema.String,
  /**
   * The plan the group falls back to, with the terms the boundary needs. Absent
   * means the group states no default and is left empty (ADR 0039 §5).
   */
  fallback: Schema.optionalKey(PlanRowSchema),
});

export type PlanCancellation = typeof PlanCancellation.Type;

/** One group cancellation inside a multi-plan operation. */
export const PlanCancellationRequest = Schema.Struct({
  group: Schema.String,
  fallback: Schema.optionalKey(PlanRowSchema),
});

export type PlanCancellationRequest = typeof PlanCancellationRequest.Type;

/** Every group with a cancellation waiting for its boundary, keyed by group. */
export const PlanCancellations = Schema.Record(Schema.String, PlanCancellation);

export type PlanCancellations = typeof PlanCancellations.Type;
