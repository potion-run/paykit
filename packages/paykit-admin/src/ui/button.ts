import * as FoldkitButton from "@foldkit/ui/button";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { classNames } from "./css.ts";

export type ButtonVariant = "default" | "destructive" | "ghost" | "link" | "outline" | "secondary";

export type ButtonSize = "default" | "icon" | "lg" | "sm";

export type ButtonOptions<Message> = Readonly<{
  readonly onClick?: Message;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly isDisabled?: boolean;
  readonly type?: "button" | "submit" | "reset";
  readonly ariaLabel?: string;
  readonly title?: string;
  readonly className?: string;
  readonly attributes?: ReadonlyArray<Attribute<Message>>;
}>;

/**
 * A shadcn button. The behavior and ARIA attributes come from `@foldkit/ui`,
 * and the styles are the `pk-btn` classes from `styles.css`.
 */
export const button = <Message>(
  h: HtmlBuilder<Message>,
  options: ButtonOptions<Message>,
  children: ReadonlyArray<Html | string>,
): Html => {
  const variant = options.variant ?? "default";
  const size = options.size ?? "default";

  return FoldkitButton.view(
    {
      onClick: options.onClick,
      isDisabled: options.isDisabled,
      type: options.type,
      toView: ({ button: attributes }) =>
        h.button(
          [
            ...attributes,
            h.Class(classNames("pk-btn", "pk-button", options.className)),
            h.DataAttribute("variant", variant),
            h.DataAttribute("size", size),
            ...(options.ariaLabel === undefined ? [] : [h.AriaLabel(options.ariaLabel)]),
            ...(options.title === undefined ? [] : [h.Title(options.title)]),
            ...(options.attributes ?? []),
          ],
          children,
        ),
    },
    h,
  );
};
