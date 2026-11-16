// Charts drawn from plain divs: GPUI lays them out natively, and nothing here
// animates, so a chart costs one redraw when its numbers change and nothing between.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { recent } from "./model.js";

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** A theme color with an opacity, for `#rrggbb` and `#rrggbbaa` alike. */
export function alpha(color, a) {
  if (typeof color !== "string" || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color)) return color;
  const base = color.slice(0, 7);
  const own = color.length === 9 ? parseInt(color.slice(7), 16) / 255 : 1;
  const v = Math.round(clamp01(a * own) * 255);
  return base + v.toString(16).padStart(2, "0");
}

/** How many bars of `bar` px with `gap` px between fit in `width`. */
export const barsIn = (width, bar, gap) => Math.max(0, Math.floor((width + gap) / (bar + gap)));

/**
 * Bars for a history, newest on the right; a value of 0 still draws a 1 px
 * floor so the shape of a quiet stretch stays visible. `scale` is what fills
 * the height (1 for fractions; the window's peak for throughput).
 */
export function sparkline(values, { width, height, color, bar = 2, gap = 1, scale = 1, floor, id }) {
  const n = barsIn(width, bar, gap);
  const data = recent(values, n);
  const last = data.length - 1;
  const base = floor ?? alpha(color, 0.25);
  return h_flex()
    .when(Boolean(id), (el) => el.id(id))
    .w(Math.max(0, width))
    .h(height)
    .flex_none()
    .items_end()
    .justify_end()
    .gap(gap)
    .overflow_hidden()
    .children(
      data.map((v, i) => {
        const h = Math.round(clamp01(scale > 0 ? v / scale : 0) * height);
        return div()
          .w(bar)
          .h(Math.max(1, h))
          .flex_none()
          .when(bar >= 3 && h > 2, (el) => el.rounded_t(1))
          .bg(h < 1 ? base : i === last ? color : alpha(color, 0.62));
      }),
    );
}

/**
 * Received above a centre line, sent below it, on one scale: the shape of a
 * download and an upload side by side in one strip.
 */
export function mirrored(up, down, { width, height, upColor, downColor, bar = 2, gap = 1, scale }) {
  const n = barsIn(width, bar, gap);
  const a = recent(up, n);
  const b = recent(down, n);
  const half = Math.floor((height - 1) / 2);
  const peak = scale ?? Math.max(64 * 1024, ...a, ...b);
  const column = (v, color, top) => {
    const h = Math.round(clamp01(v / peak) * half);
    return h_flex().h(half).flex_none().when(top, (el) => el.items_end()).child(div().w(bar).h(Math.max(h, v > 0 ? 1 : 0)).bg(color));
  };
  return v_flex()
    .w(Math.max(0, width))
    .h(height)
    .flex_none()
    .overflow_hidden()
    .child(h_flex().h(half).justify_end().gap(gap).children(a.map((v, i) => column(v, i === a.length - 1 ? upColor : alpha(upColor, 0.62), true))))
    .child(div().h(1).w_full().bg(alpha(upColor, 0.18)))
    .child(h_flex().h(half).justify_end().gap(gap).children(b.map((v, i) => column(v, i === b.length - 1 ? downColor : alpha(downColor, 0.62), false))));
}

/** A fill bar: `fraction` of `width`, eighth-pixel crisp, on a faint track. */
export function bar(fraction, { width, height = 5, color, track }) {
  const w = Math.max(0, width);
  const fill = Math.round(clamp01(fraction) * w);
  return div()
    .w(w)
    .h(height)
    .flex_none()
    .rounded(height / 2)
    .overflow_hidden()
    .bg(track)
    .child(div().h_full().w(fill).rounded(height / 2).bg(color));
}

/** Parts of a whole on one track, left to right: memory as app, wired and compressed. */
export function stacked(parts, { width, height = 5, track }) {
  const w = Math.max(0, width);
  let used = 0;
  const pieces = [];
  for (const p of parts) {
    const px = Math.min(w - used, Math.round(clamp01(p.fraction) * w));
    if (px <= 0) continue;
    pieces.push(div().h_full().w(px).flex_none().bg(p.color));
    used += px;
  }
  return h_flex().w(w).h(height).flex_none().rounded(height / 2).overflow_hidden().bg(track).children(pieces);
}

/**
 * One cell per core, filled from the bottom by its load, with a wider gap
 * where the efficiency cluster starts. `colorOf(load)` picks each cell's color.
 */
export function coreCells(cells, split, { width, height, colorOf, track, gap = 2, clusterGap = 6 }) {
  const n = cells.length;
  if (!n) return div();
  const extra = split ? clusterGap - gap : 0;
  const cw = Math.max(2, Math.floor((width - gap * (n - 1) - extra) / n));
  return h_flex()
    .h(height)
    .flex_none()
    .items_end()
    .children(
      cells.map((v, i) => {
        const fill = Math.round(clamp01(v) * height);
        return v_flex()
          .w(cw)
          .h(height)
          .flex_none()
          .ml(i === 0 ? 0 : i === split ? clusterGap : gap)
          .rounded(Math.min(2, cw / 3))
          .overflow_hidden()
          .justify_end()
          .bg(track)
          .child(div().w_full().h(Math.max(fill, v > 0.02 ? 1 : 0)).bg(colorOf(v)));
      }),
    );
}

/** How many core cells fit at a given cell width (for pooling before drawing). */
export const cellsIn = (width, min = 4, gap = 2) => Math.max(1, Math.floor((width + gap) / (min + gap)));
