import * as FoldkitInput from "@foldkit/ui/input";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { classNames } from "./css.ts";

export type InputOptions<Message> = Readonly<{
  readonly id: string;
  readonly value: string;
  readonly onInput: (value: string) => Message;
  readonly type?: string;
  readonly placeholder?: string;
  readonly isDisabled?: boolean;
  readonly isInvalid?: boolean;
  readonly className?: string;
  readonly attributes?: ReadonlyArray<Attribute<Message>>;
}>;

/** A shadcn input. Label association and invalid state come from `@foldkit/ui`. */
export const input = <Message>(h: HtmlBuilder<Message>, options: InputOptions<Message>): Html =>
  FoldkitInput.view(
    {
      id: options.id,
      value: options.value,
      onInput: options.onInput,
      type: options.type,
      placeholder: options.placeholder,
      isDisabled: options.isDisabled,
      isInvalid: options.isInvalid,
      toView: ({ input: attributes }) =>
        h.input([
          ...attributes,
          h.Class(classNames("pk-input", options.className)),
          h.DataAttribute("slot", "input"),
          ...(options.attributes ?? []),
        ]),
    },
    h,
  );
