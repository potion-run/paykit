import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { classNames } from "./css.ts";

type Children = ReadonlyArray<Html | string>;

export type TabListOptions<Message> = Readonly<{
  readonly label?: string;
  readonly className?: string;
  readonly attributes?: ReadonlyArray<Attribute<Message>>;
}>;

/** A shadcn tab list. The parent owns the active tab. */
export const tabList = <Message>(
  h: HtmlBuilder<Message>,
  options: TabListOptions<Message>,
  children: ReadonlyArray<Html>,
): Html =>
  h.div(
    [
      h.Role("tablist"),
      h.Class(classNames("pk-tabs-list", options.className)),
      h.DataAttribute("slot", "tabs-list"),
      ...(options.label === undefined ? [] : [h.AriaLabel(options.label)]),
      ...(options.attributes ?? []),
    ],
    children,
  );

export type TabOptions<Message> = Readonly<{
  readonly isActive: boolean;
  readonly onClick: Message;
  readonly className?: string;
  readonly attributes?: ReadonlyArray<Attribute<Message>>;
}>;

export const tab = <Message>(
  h: HtmlBuilder<Message>,
  options: TabOptions<Message>,
  children: Children,
): Html =>
  h.button(
    [
      h.Type("button"),
      h.Role("tab"),
      h.AriaSelected(options.isActive),
      h.Tabindex(options.isActive ? 0 : -1),
      h.Class(classNames("pk-tab", options.className)),
      h.OnClick(options.onClick),
      h.DataAttribute("slot", "tab"),
      ...(options.isActive ? [h.DataAttribute("active", "")] : []),
      ...(options.attributes ?? []),
    ],
    children,
  );

export type TabPanelOptions = Readonly<{
  readonly id?: string;
  readonly isActive: boolean;
  readonly className?: string;
}>;

export const tabPanel = <Message>(
  h: HtmlBuilder<Message>,
  options: TabPanelOptions,
  children: Children,
): Html =>
  h.div(
    [
      h.Role("tabpanel"),
      h.Class(classNames("pk-tab-panel", options.className)),
      h.Tabindex(0),
      h.Hidden(!options.isActive),
      h.DataAttribute("slot", "tab-panel"),
      ...(options.id === undefined ? [] : [h.Id(options.id)]),
    ],
    children,
  );
