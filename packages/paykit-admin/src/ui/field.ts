import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { classNames } from "./css.ts";

export type FieldOptions<Message> = Readonly<{
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly error?: string;
  readonly className?: string;
  readonly attributes?: ReadonlyArray<Attribute<Message>>;
}>;

/**
 * A shadcn field: label, control, optional description and error. The caller
 * passes the control so the same field composes input, textarea and select.
 */
export const field = <Message>(
  h: HtmlBuilder<Message>,
  options: FieldOptions<Message>,
  children: ReadonlyArray<Html>,
): Html =>
  h.div(
    [
      h.Class(classNames("pk-field", options.className)),
      h.DataAttribute("slot", "field"),
      ...(options.attributes ?? []),
    ],
    [
      h.label([h.For(options.id), h.Class("pk-field-label")], [options.label]),
      ...children,
      ...(options.description === undefined
        ? []
        : [h.p([h.Class("pk-field-description")], [options.description])]),
      ...(options.error === undefined ? [] : [h.p([h.Class("pk-field-error")], [options.error])]),
    ],
  );
