import * as FoldkitSelect from "@foldkit/ui/select";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { classNames } from "./css.ts";

export type SelectOption = Readonly<{
  readonly value: string;
  readonly label: string;
  readonly isDisabled?: boolean;
}>;

export type SelectOptions<Message> = Readonly<{
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => Message;
  readonly options: ReadonlyArray<SelectOption>;
  readonly isDisabled?: boolean;
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly attributes?: ReadonlyArray<Attribute<Message>>;
}>;

/** A shadcn native select. */
export const select = <Message>(h: HtmlBuilder<Message>, options: SelectOptions<Message>): Html =>
  FoldkitSelect.view(
    {
      id: options.id,
      value: options.value,
      onChange: options.onChange,
      isDisabled: options.isDisabled,
      toView: ({ select: attributes }) =>
        h.select(
          [
            ...attributes,
            h.Class(classNames("pk-select", options.className)),
            h.DataAttribute("slot", "select"),
            ...(options.ariaLabel === undefined ? [] : [h.AriaLabel(options.ariaLabel)]),
            ...(options.attributes ?? []),
          ],
          options.options.map((option) =>
            h.option(
              [
                h.Value(option.value),
                h.Selected(option.value === options.value),
                ...(option.isDisabled === true ? [h.Disabled(true)] : []),
              ],
              [option.label],
            ),
          ),
        ),
    },
    h,
  );
