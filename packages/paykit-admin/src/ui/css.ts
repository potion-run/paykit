import { Predicate } from "effect";

/** Join the truthy class names. The shadcn kit uses this instead of clsx. */
export const classNames = (...values: ReadonlyArray<string | false | null | undefined>): string =>
  values.filter(Predicate.isString).join(" ");
