import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { classNames } from "./css.ts";

type Children = ReadonlyArray<Html | string>;

export type TableOptions<Message> = Readonly<{
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly attributes?: ReadonlyArray<Attribute<Message>>;
}>;

/** A shadcn table, wrapped in the horizontal scroll container. */
export const table = <Message>(
  h: HtmlBuilder<Message>,
  children: ReadonlyArray<Html>,
  options: TableOptions<Message> = {},
): Html =>
  h.div(
    [h.Class("pk-table-wrap"), h.DataAttribute("slot", "table-container")],
    [
      h.table(
        [
          h.Class(classNames("pk-table", options.className)),
          h.DataAttribute("slot", "table"),
          ...(options.ariaLabel === undefined ? [] : [h.AriaLabel(options.ariaLabel)]),
          ...(options.attributes ?? []),
        ],
        children,
      ),
    ],
  );

export const tableHeader = <Message>(
  h: HtmlBuilder<Message>,
  children: ReadonlyArray<Html>,
): Html => h.thead([h.DataAttribute("slot", "table-header")], children);

export const tableBody = <Message>(h: HtmlBuilder<Message>, children: ReadonlyArray<Html>): Html =>
  h.tbody([h.DataAttribute("slot", "table-body")], children);

export const tableRow = <Message>(
  h: HtmlBuilder<Message>,
  children: ReadonlyArray<Html>,
  options: Readonly<{
    readonly key?: string;
    readonly className?: string;
    readonly attributes?: ReadonlyArray<Attribute<Message>>;
  }> = {},
): Html => {
  const attributes = [
    h.Class(classNames("pk-table-row", options.className)),
    h.DataAttribute("slot", "table-row"),
    ...(options.attributes ?? []),
  ];

  return options.key === undefined
    ? h.tr(attributes, children)
    : h.keyed("tr")(options.key, attributes, children);
};

export const tableHead = <Message>(
  h: HtmlBuilder<Message>,
  children: Children,
  options: Readonly<{ readonly className?: string }> = {},
): Html =>
  h.th([h.Scope("col"), h.Class(classNames("pk-table-head", options.className))], children);

export const tableCell = <Message>(
  h: HtmlBuilder<Message>,
  children: Children,
  options: Readonly<{
    readonly className?: string;
    readonly attributes?: ReadonlyArray<Attribute<Message>>;
  }> = {},
): Html =>
  h.td(
    [h.Class(classNames("pk-table-cell", options.className)), ...(options.attributes ?? [])],
    children,
  );
