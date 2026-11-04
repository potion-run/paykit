import * as Domain from "@alchemy.run/domain";

/** There is no scheduled cancellation to withdraw. */
export class NotScheduled extends Domain.Rejection("NotScheduled") {}
