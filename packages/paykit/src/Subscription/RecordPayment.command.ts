import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Admin } from "../Auth/Guards.ts";
import { NotInGrace } from "./NotInGrace.rejection.ts";
import { AccountId } from "./Subscription.id.ts";

/** A payment landed and the standing is active again. */
export class PaymentRecorded extends Domain.Event("PaymentRecorded", {
  amount: Schema.Int,
  currency: Schema.String,
  /** The provider's charge, when the payment reports one. */
  chargeId: Schema.optionalKey(Schema.String),
  statusAfter: Schema.Literal("active"),
}) {}

/** Record a payment that recovers an account in grace. */
export class RecordPayment extends Domain.Command("RecordPayment", {
  target: AccountId,
  input: {
    amount: Schema.Int,
    currency: Schema.String,
    chargeId: Schema.optionalKey(Schema.String),
  },
  events: [PaymentRecorded],
  rejects: [NotInGrace],
  middleware: [Admin],
}) {}
