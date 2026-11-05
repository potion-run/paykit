import * as FoldkitTextarea from "@foldkit/ui/textarea";
import type { Html, HtmlBuilder, TextareaAttribute } from "foldkit/html";
import { classNames } from "./css.ts";

export type TextareaOptions<Message> = Readonly<{
  readonly id: string;
  readonly value: string;
  readonly onInput: (value: string) => Message;
  readonly rows?: number;
  readonly placeholder?: string;
  readonly isDisabled?: boolean;
  readonly isInvalid?: boolean;
  readonly className?: string;
  readonly attributes?: ReadonlyArray<TextareaAttribute<Message>>;
}>;

/** A shadcn textarea. */
export const textarea = <Message>(
  h: HtmlBuilder<Message>,
  options: TextareaOptions<Message>,
): Html =>
  FoldkitTextarea.view(
    {
      id: options.id,
      value: options.value,
      onInput: options.onInput,
      rows: options.rows,
      placeholder: options.placeholder,
      isDisabled: options.isDisabled,
      isInvalid: options.isInvalid,
      toView: ({ textarea: attributes }) =>
        h.textarea([
          ...attributes,
          h.Class(classNames("pk-textarea", options.className)),
          h.DataAttribute("slot", "textarea"),
          ...(options.attributes ?? []),
        ]),
    },
    h,
  );
