import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { AccountId } from "./Subscription.id.ts";
import { ProviderRefs } from "./Subscription.state.ts";

/** A vendor id was stored, keyed by provider. Nothing else in the model reads it. */
export class ProviderRefAttached extends Domain.Event("ProviderRefAttached", {
  provider: Schema.String,
  refs: ProviderRefs,
}) {}

/**
 * Attach vendor identifiers for an account. A provider adapter calls this
 * after checkout; `decide` never reads the result.
 */
export class AttachProviderRef extends Domain.Command("AttachProviderRef", {
  target: AccountId,
  input: {
    provider: Schema.String,
    refs: ProviderRefs,
  },
  events: [ProviderRefAttached],
  rejects: [],
}) {}
