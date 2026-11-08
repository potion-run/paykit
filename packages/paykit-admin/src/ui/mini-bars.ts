import type { Html, HtmlBuilder } from "foldkit/html";
import { classNames } from "./css.ts";

export type MiniBarsOptions = Readonly<{
  /** Bucket values, oldest first. Negative and non-finite values draw as zero. */
  readonly values: ReadonlyArray<number>;
  readonly color?: string;
  readonly floor?: number;
  readonly floorColor?: string;
  readonly minHeight?: number;
  readonly gap?: number;
  readonly opacityRamp?: boolean;
  readonly className?: string;
  /** Accessible name; the bars are decorative without one. */
  readonly label?: string;
}>;

const finite = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/**
 * A compact static bar strip in one SVG, adapted for Foldkit from the
 * MapleTechLabs/maple `mini-bars` component. It has no runtime and no time
 * scale: feed it already-bucketed values and it draws them.
 */
export const miniBars = <Message>(h: HtmlBuilder<Message>, options: MiniBarsOptions): Html => {
  const { values, label } = options;
  const color = options.color ?? "currentColor";
  const floor = options.floor ?? 0;
  const minHeight = options.minHeight ?? 5;
  const gap = options.gap ?? 2;
  const count = values.length;
  const max = count === 0 ? 0 : Math.max(...values.map(finite));
  const barWidth = Math.max((100 - gap * Math.max(0, count - 1)) / Math.max(count, 1), 0.5);

  const bars = values.flatMap((raw, index) => {
    const value = finite(raw);
    const x = index * (barWidth + gap);

    if (value === 0) {
      if (floor <= 0) return [];

      return [
        h.rect([
          h.Attribute("x", String(x)),
          h.Attribute("y", String(100 - floor)),
          h.Attribute("width", String(barWidth)),
          h.Attribute("height", String(floor)),
          h.Attribute("fill", options.floorColor ?? color),
          h.Attribute("opacity", "0.25"),
        ]),
      ];
    }

    const ratio = max > 0 ? value / max : 0;
    const height = Math.max(ratio * 100, minHeight);
    const opacity = options.opacityRamp === true ? 0.35 + ratio * 0.65 : 1;

    return [
      h.rect([
        h.Attribute("x", String(x)),
        h.Attribute("y", String(100 - height)),
        h.Attribute("width", String(barWidth)),
        h.Attribute("height", String(height)),
        h.Attribute("fill", color),
        h.Attribute("opacity", String(opacity)),
        h.Attribute("rx", "1"),
      ]),
    ];
  });

  return h.svg(
    [
      h.Attribute("viewBox", "0 0 100 100"),
      h.Attribute("preserveAspectRatio", "none"),
      h.Class(classNames("pk-mini-bars", options.className)),
      ...(label === undefined
        ? [h.Attribute("aria-hidden", "true")]
        : [h.Attribute("role", "img"), h.Attribute("aria-label", label)]),
      h.DataAttribute("slot", "mini-bars"),
    ],
    [...(label === undefined ? [] : [h.title([], [label])]), ...bars],
  );
};
