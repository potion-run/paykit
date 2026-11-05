import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { classNames } from "./css.ts";

type Children = ReadonlyArray<Html | string>;

export type AlertVariant = "default" | "destructive" | "info" | "success" | "warning";

export type AlertOptions<Message> = Readonly<{
  readonly variant?: AlertVariant;
  readonly role?: string;
  readonly className?: string;
  readonly attributes?: ReadonlyArray<Attribute<Message>>;
}>;

/** A shadcn alert. The variant selects a semantic tint, never a raw color. */
export const alert = <Message>(
  h: HtmlBuilder<Message>,
  options: AlertOptions<Message>,
  children: Children,
): Html =>
  h.div(
    [
      h.Class(classNames("pk-alert", options.className)),
      h.DataAttribute("variant", options.variant ?? "default"),
      h.DataAttribute("slot", "alert"),
      h.Role(options.role ?? "alert"),
      ...(options.attributes ?? []),
    ],
    children,
  );

export const alertTitle = <Message>(
  h: HtmlBuilder<Message>,
  children: Children,
  options: Readonly<{ readonly className?: string }> = {},
): Html => h.p([h.Class(classNames("pk-alert-title", options.className))], children);

export const alertDescription = <Message>(
  h: HtmlBuilder<Message>,
  children: Children,
  options: Readonly<{ readonly className?: string }> = {},
): Html => h.div([h.Class(classNames("pk-alert-description", options.className))], children);
