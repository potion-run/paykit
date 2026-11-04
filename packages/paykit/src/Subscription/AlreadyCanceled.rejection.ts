import * as Domain from "@alchemy.run/domain";

/** Cancellation is already scheduled, or the standing is already over. */
export class AlreadyCanceled extends Domain.Rejection("AlreadyCanceled") {}
