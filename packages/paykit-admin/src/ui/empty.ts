import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { classNames } from "./css.ts";

type Children = ReadonlyArray<Html | string>;

export type EmptyOptions<Message> = Readonly<{
  readonly title: string;
  readonly description?: string;
  readonly className?: string;
  readonly attributes?: ReadonlyArray<Attribute<Message>>;
}>;

/** A shadcn empty state: title, optional description, optional actions. */
export const empty = <Message>(
  h: HtmlBuilder<Message>,
  options: EmptyOptions<Message>,
  children: Children = [],
): Html =>
  h.div(
    [
      h.Class(classNames("pk-empty", options.className)),
      h.DataAttribute("slot", "empty"),
      ...(options.attributes ?? []),
    ],
    [
      h.h3([h.Class("pk-empty-title")], [options.title]),
      ...(options.description === undefined
        ? []
        : [h.p([h.Class("pk-empty-description")], [options.description])]),
      ...children,
    ],
  );
