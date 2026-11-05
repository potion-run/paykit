import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { classNames } from "./css.ts";

type Children = ReadonlyArray<Html | string>;

export type CardOptions<Message> = Readonly<{
  readonly className?: string;
  readonly attributes?: ReadonlyArray<Attribute<Message>>;
}>;

/** A shadcn card. The console's panels use the same class set. */
export const card = <Message>(
  h: HtmlBuilder<Message>,
  children: Children,
  options: CardOptions<Message> = {},
): Html =>
  h.section(
    [
      h.Class(classNames("pk-card", "pk-panel", options.className)),
      h.DataAttribute("slot", "card"),
      ...(options.attributes ?? []),
    ],
    children,
  );

export const cardHeader = <Message>(
  h: HtmlBuilder<Message>,
  children: Children,
  options: CardOptions<Message> = {},
): Html =>
  h.div(
    [
      h.Class(classNames("pk-card-header", "pk-panel-head", options.className)),
      h.DataAttribute("slot", "card-header"),
      ...(options.attributes ?? []),
    ],
    children,
  );

export const cardTitle = <Message>(
  h: HtmlBuilder<Message>,
  children: Children,
  options: CardOptions<Message> = {},
): Html =>
  h.h2(
    [
      h.Class(classNames("pk-card-title", options.className)),
      h.DataAttribute("slot", "card-title"),
    ],
    children,
  );

export const cardDescription = <Message>(
  h: HtmlBuilder<Message>,
  children: Children,
  options: CardOptions<Message> = {},
): Html =>
  h.p(
    [
      h.Class(classNames("pk-card-description", options.className)),
      h.DataAttribute("slot", "card-description"),
    ],
    children,
  );

export const cardContent = <Message>(
  h: HtmlBuilder<Message>,
  children: Children,
  options: CardOptions<Message> = {},
): Html =>
  h.div(
    [
      h.Class(classNames("pk-card-content", options.className)),
      h.DataAttribute("slot", "card-content"),
      ...(options.attributes ?? []),
    ],
    children,
  );

export const cardFooter = <Message>(
  h: HtmlBuilder<Message>,
  children: Children,
  options: CardOptions<Message> = {},
): Html =>
  h.div(
    [
      h.Class(classNames("pk-card-footer", options.className)),
      h.DataAttribute("slot", "card-footer"),
      ...(options.attributes ?? []),
    ],
    children,
  );
