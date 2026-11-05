import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { classNames } from "./css.ts";

export type BadgeVariant =
  | "default"
  | "destructive"
  | "info"
  | "outline"
  | "secondary"
  | "success"
  | "warning";

export type BadgeOptions<Message> = Readonly<{
  readonly variant?: BadgeVariant;
  readonly className?: string;
  readonly attributes?: ReadonlyArray<Attribute<Message>>;
}>;

/** A shadcn badge. Status variants use the semantic tokens, not raw colors. */
export const badge = <Message>(
  h: HtmlBuilder<Message>,
  options: BadgeOptions<Message>,
  children: ReadonlyArray<Html | string>,
): Html =>
  h.span(
    [
      h.Class(classNames("pk-badge", options.className)),
      h.DataAttribute("variant", options.variant ?? "default"),
      h.DataAttribute("slot", "badge"),
      ...(options.attributes ?? []),
    ],
    children,
  );
