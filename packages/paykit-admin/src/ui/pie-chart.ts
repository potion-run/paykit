import type { Html, HtmlBuilder } from "foldkit/html";
import { classNames } from "./css.ts";

export type PieSegment = Readonly<{
  label: string;
  value: number;
  color: string;
}>;

export type PieChartOptions = Readonly<{
  segments: ReadonlyArray<PieSegment>;
  centerValue?: string;
  centerLabel?: string;
  size?: number;
  className?: string;
  label?: string;
}>;

const finite = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/**
 * A small SVG donut for a categorical breakdown. Segments are drawn as
 * percentage dashes around one circle, so the chart needs no chart runtime.
 */
export const pieChart = <Message>(h: HtmlBuilder<Message>, options: PieChartOptions): Html => {
  const values = options.segments.map((segment) => ({ ...segment, value: finite(segment.value) }));
  const total = values.reduce((sum, segment) => sum + segment.value, 0);
  let offset = 0;

  const rings = values.flatMap((segment) => {
    if (segment.value === 0 || total === 0) return [];
    const percentage = (segment.value / total) * 100;

    const circle = h.circle([
      h.Attribute("cx", "21"),
      h.Attribute("cy", "21"),
      h.Attribute("r", "15.9155"),
      h.Attribute("fill", "none"),
      h.Attribute("stroke", segment.color),
      h.Attribute("stroke-width", "6"),
      h.Attribute("stroke-dasharray", `${percentage} ${100 - percentage}`),
      h.Attribute("stroke-dashoffset", String(-offset)),
      h.Attribute("transform", "rotate(-90 21 21)"),
    ]);

    offset += percentage;

    return [circle];
  });

  return h.div(
    [
      h.Class(classNames("pk-pie", options.className)),
      h.Style({ width: `${options.size ?? 160}px`, height: `${options.size ?? 160}px` }),
      ...(options.label === undefined ? [] : [h.AriaLabel(options.label)]),
    ],
    [
      h.svg(
        [
          h.Attribute("viewBox", "0 0 42 42"),
          h.Class("pk-pie-svg"),
          h.Attribute("aria-hidden", "true"),
        ],
        [
          h.circle([
            h.Attribute("cx", "21"),
            h.Attribute("cy", "21"),
            h.Attribute("r", "15.9155"),
            h.Attribute("fill", "none"),
            h.Attribute("stroke", "var(--pk-muted)"),
            h.Attribute("stroke-width", "6"),
          ]),
          ...rings,
        ],
      ),
      h.div(
        [h.Class("pk-pie-center")],
        [
          h.strong([h.Class("pk-pie-value")], [options.centerValue ?? String(total)]),
          ...(options.centerLabel === undefined
            ? []
            : [h.span([h.Class("pk-pie-label")], [options.centerLabel])]),
        ],
      ),
    ],
  );
};
