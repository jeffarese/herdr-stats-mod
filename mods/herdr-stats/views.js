// Every way the stats can look. Each view takes `ui` (what to show, how big,
// what clicks do) and returns elements; main.js decides which one a copy is.

import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { alpha, sparkline, mirrored, bar, stacked, coreCells, cellsIn } from "./charts.js";
import { bytes, rate, pct, cores as coreLoad, degrees, uptime, rpm } from "./format.js";
import { METRICS, poolCores, busiest } from "./model.js";
import { SPOTS } from "./placement.js";

const ICON = (name) => `mods/herdr-stats/${name}.svg`;
const HUE = { cpu: "ansi4", mem: "ansi5", gpu: "ansi2", disk: "ansi6", rx: "ansi6", tx: "ansi4" };

export function tone(t, kind, level) {
  if (level === "crit") return t.ansi1 ?? t.blocked;
  if (level === "warn") return t.ansi3 ?? t.working;
  return t[HUE[kind]] ?? t.accent;
}
const textTone = (t, level) => (level === "crit" ? t.ansi1 ?? t.blocked : level === "warn" ? t.ansi3 ?? t.working : t.foreground);
const track = (t) => alpha(t.foreground, 0.09);

function programIcon(p, size, color) {
  if (!p?.icon) return svg(ICON("terminal")).size(size).flex_none().text_color(color);
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(p.color ?? color) : image(p.icon).w(size).h(size).flex_none();
}

// What a copy says while there are no numbers to show.
function waiting(ui) {
  const { t } = ui;
  if (ui.problem) {
    return h_flex()
      .id("problem")
      .gap(8)
      .items_center()
      .text_size(11.5)
      .text_color(t.muted)
      .cursor_pointer()
      .on_click(() => ui.act.dashboard())
      .tooltip(ui.problem.detail ?? ui.problem.text)
      .child(div().size(7).rounded(4).flex_none().bg(t.ansi3 ?? t.working))
      .child(div().min_w(0).truncate().child(ui.problem.text));
  }
  return h_flex()
    .gap(8)
    .items_center()
    .text_size(11.5)
    .text_color(t.dim)
    .child(div().size(7).rounded(4).flex_none().bg(t.accent).loop("opacity", { from: 0.25, to: 1, period: 1200 }))
    .child("Reading the machine…");
}

// ---------------------------------------------------------------------------
// The sidebar panel: a header like Herdr's own lists, then one line per reading.

const PANEL = { pad: 16, header: 41, row: 22, rowGap: 3, coreRow: 11, label: 50, value: 44, gap: 8, icon: 13, bottom: 10 };

function panelRows(ui) {
  const { r, metrics } = ui;
  const rows = [];
  for (const m of metrics) {
    if (m === "cpu") {
      rows.push({ id: "cpu", h: PANEL.row });
      if (r.cpu.cores.length > 1) rows.push({ id: "cores", h: PANEL.coreRow, optional: true });
    } else if (m === "mem" && r.mem) rows.push({ id: "mem", h: PANEL.row });
    else if (m === "gpu" && r.gpu) rows.push({ id: "gpu", h: PANEL.row });
    else if (m === "net" && r.net) rows.push({ id: "net", h: PANEL.row });
    else if (m === "disk" && r.disk) rows.push({ id: "disk", h: PANEL.row });
    else if (m === "temp" && (r.temp || r.fan)) rows.push({ id: "temp", h: PANEL.row });
    else if (m === "top" && ui.top) rows.push({ id: "top", h: PANEL.row });
  }
  return rows;
}

/** The rows that fit in `height`, in the person's order; when not all fit, the core cells go first. */
export function fitRows(rows, height) {
  const room = height - PANEL.header - PANEL.bottom;
  const need = (list) => list.reduce((a, r) => a + r.h + PANEL.rowGap, 0);
  const list = need(rows) <= room ? rows : rows.filter((r) => !r.optional);
  const out = [];
  let used = 0;
  for (const row of list) {
    if (used + row.h + PANEL.rowGap > room) break;
    used += row.h + PANEL.rowGap;
    out.push(row);
  }
  return out;
}

/** The height the panel needs for every row it would show: for sizing its block. */
export function panelHeight(ui) {
  return PANEL.header + PANEL.bottom + panelRows(ui).reduce((a, r) => a + r.h + PANEL.rowGap, 0);
}

export function panel(ui) {
  const { t, r, mono } = ui;
  const inner = Math.max(80, ui.width - PANEL.pad * 2);
  const labels = ui.width >= 236;
  const chartW = Math.max(16, inner - PANEL.icon - PANEL.gap - (labels ? PANEL.label + PANEL.gap : 0) - PANEL.gap - PANEL.value);
  const lead = PANEL.icon + PANEL.gap + (labels ? PANEL.label + PANEL.gap : 0);

  const line = (id, icon, label, chart, value, valueColor, tooltip) =>
    h_flex()
      .id(`row-${id}`)
      .h(PANEL.row)
      .flex_none()
      .items_center()
      .gap(PANEL.gap)
      .rounded(6)
      .cursor_pointer()
      .on_click(() => ui.act.dashboard())
      .when(Boolean(tooltip), (el) => el.tooltip(tooltip))
      .child(icon)
      .when(labels, (el) => el.child(div().w(PANEL.label).flex_none().truncate().text_size(11.5).text_color(t.muted).child(label)))
      .child(h_flex().w(chartW).flex_none().items_center().child(chart))
      .child(div().w(PANEL.value).flex_none().text_right().font_family(mono).text_size(11.5).text_color(valueColor).child(value));
  const glyph = (name) => svg(ICON(name)).size(PANEL.icon).flex_none().text_color(t.dim);

  const draw = {
    cpu: () =>
      line(
        "cpu",
        glyph("cpu"),
        "CPU",
        sparkline(r.cpu.hist, { width: chartW, height: 14, color: tone(t, "cpu", r.cpu.level) }),
        pct(r.cpu.value),
        textTone(t, r.cpu.level),
        cpuTip(r),
      ),
    cores: () => {
      const { cells, split } = poolCores(r.cpu.cores, cellsIn(chartW, 3, 2), r.cpu.pcores);
      return h_flex()
        .h(PANEL.coreRow)
        .flex_none()
        .items_center()
        .child(div().w(lead).flex_none())
        .child(coreCells(cells, split, { width: chartW, height: 8, gap: 2, clusterGap: 5, track: track(t), colorOf: (v) => alpha(tone(t, "cpu", v >= 0.9 ? "crit" : v >= 0.7 ? "warn" : "ok"), 0.9) }));
    },
    mem: () =>
      line(
        "mem",
        glyph("memory"),
        "Memory",
        memoryBar(t, r.mem, chartW, 5),
        bytes(r.mem.used, { compact: true }),
        textTone(t, r.mem.level),
        memTip(r.mem),
      ),
    gpu: () =>
      line("gpu", glyph("gpu"), "GPU", sparkline(r.gpu.hist, { width: chartW, height: 14, color: tone(t, "gpu", r.gpu.level) }), pct(r.gpu.value), textTone(t, r.gpu.level), gpuTip(r.gpu)),
    net: () =>
      line(
        "net",
        glyph("net"),
        "Network",
        mirrored(r.net.rxHist, r.net.txHist, { width: chartW, height: 15, upColor: tone(t, "rx"), downColor: tone(t, "tx") }),
        rate(Math.max(r.net.rx, r.net.tx), { compact: true }),
        t.foreground,
        `↓ ${rate(r.net.rx)}  ↑ ${rate(r.net.tx)}`,
      ),
    disk: () => line("disk", glyph("disk"), "Disk", bar(r.disk.fraction, { width: chartW, height: 5, color: tone(t, "disk", r.disk.level), track: track(t) }), pct(r.disk.fraction), textTone(t, r.disk.level), diskTip(r.disk)),
    // No label or value column here: the icon, then each sensor as "CPU 82°", as many as fit.
    temp: () =>
      h_flex()
        .id("row-temp")
        .h(PANEL.row)
        .flex_none()
        .items_center()
        .gap(PANEL.gap)
        .rounded(6)
        .cursor_pointer()
        .on_click(() => ui.act.dashboard())
        .tooltip(sensorTip(r))
        .child(glyph("temp"))
        .child(h_flex().flex_1().min_w(0).gap(SENSOR_GAP).items_center().children(sensorReadings(ui, inner - PANEL.icon - PANEL.gap))),
    top: () => {
      const b = ui.top;
      return h_flex()
        .id("row-top")
        .h(PANEL.row)
        .flex_none()
        .items_center()
        .gap(PANEL.gap)
        .rounded(6)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(() => ui.act.go(b))
        .tooltip(`Busiest terminal: ${b.name}${b.where ? ` in ${b.where}` : ""} · ${coreLoad(b.cpu)} CPU · ${bytes(b.rss)} · ${b.procs} processes. Click to go to it.`)
        .child(programIcon(b.program, PANEL.icon, t.muted))
        .child(
          h_flex()
            .flex_1()
            .min_w(0)
            .gap(5)
            .items_center()
            .text_size(11.5)
            .child(div().flex_none().max_w(110).truncate().text_color(t.foreground).child(b.name))
            .when(Boolean(b.where), (el) => el.child(div().min_w(0).truncate().text_color(t.dim).child(b.where))),
        )
        .child(div().w(PANEL.value).flex_none().text_right().font_family(mono).text_size(11.5).text_color(textTone(t, b.cpu >= 2 ? "warn" : "ok")).child(coreLoad(b.cpu)));
    },
  };

  const header = h_flex()
    .px(PANEL.pad)
    .h(PANEL.header)
    .pt(14)
    .pb(5)
    .flex_none()
    .items_center()
    .gap(6)
    .child(div().text_size(11.5).font_medium().text_color(t.dim).child("System"))
    .when(Boolean(ui.stale && r), (el) => el.child(div().text_size(10.5).text_color(t.dim).child("· paused")))
    .child(div().flex_1())
    .when(ui.fold, el => el.child(ui.fold))
    .child(iconButton(ui, "open-dashboard", "expand", `Open the dashboard${ui.dashKey ? `  ${ui.dashKey}` : ""}`, () => ui.act.dashboard()))
    .child(iconButton(ui, "panel-menu", "more", "Show in… and readings", () => ui.act.menu()));

  const body = v_flex().px(PANEL.pad).gap(PANEL.rowGap).flex_1().min_h(0).overflow_hidden();
  const content = r ? fitRows(panelRows(ui), ui.height).map((row) => draw[row.id]()) : [waiting(ui)];
  return v_flex()
    .id("root")
    .size_full()
    .min_h(0)
    .bg(t.chrome)
    .border_t(1)
    .border_color(t.border)
    .on_size_change((size, cx) => ui.act.resized(size, cx))
    .child(header)
    .child(body.when(ui.stale && Boolean(r), (el) => el.opacity(0.55)).children(content));
}

function iconButton(ui, id, icon, tip, onClick) {
  const { t } = ui;
  return div()
    .id(id)
    .size(20)
    .flex_none()
    .rounded(5)
    .flex()
    .items_center()
    .justify_center()
    .text_color(t.dim)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => {
      cx.stop_propagation();
      onClick();
    })
    .tooltip(tip)
    .child(svg(ICON(icon)).size(13));
}

function memoryBar(t, m, width, height) {
  const base = tone(t, "mem", m.level);
  return stacked(
    [
      { fraction: m.app / m.total, color: base },
      { fraction: m.wired / m.total, color: alpha(base, 0.7) },
      { fraction: m.compressed / m.total, color: alpha(base, 0.42) },
    ],
    { width, height, track: track(t) },
  );
}

const cpuTip = (r) => {
  const parts = [`CPU ${pct(r.cpu.value)}`, `busiest core ${pct(r.cpu.max)}`];
  if (r.cpu.p !== null && r.cpu.e !== null) parts.push(`performance ${pct(r.cpu.p)}`, `efficiency ${pct(r.cpu.e)}`);
  if (r.load) parts.push(`load ${r.load.map((v) => v.toFixed(2)).join(" ")}`);
  return `${parts.join(" · ")} · ${r.cpu.cores.length} cores`;
};
const memTip = (m) =>
  [`${bytes(m.used)} of ${bytes(m.total)}`, `app ${bytes(m.app)}`, `wired ${bytes(m.wired)}`, `compressed ${bytes(m.compressed)}`, m.swap ? `swap ${bytes(m.swap)}` : null, m.pressure !== null ? `pressure ${pct(m.pressure)}` : null]
    .filter(Boolean)
    .join(" · ");
const gpuTip = (g) => [`GPU ${pct(g.value)}`, g.memory ? `${bytes(g.memory)} in use` : null].filter(Boolean).join(" · ");
const diskTip = (d) => `${bytes(d.used)} used of ${bytes(d.total)} · ${bytes(d.available)} free`;
const SHORT = { Battery: "Bat" };
const SENSOR_GAP = 10;

/**
 * The panel's sensor line: "CPU 82°  GPU 61°  SoC 56°  SSD 38°  Bat 37°  ⟳ 3.0k", left to
 * right in that order, ending where `width` runs out. Each value takes its own severity
 * color. Widths are estimated from character counts (11 px UI, 11.5 px terminal font).
 */
export function sensorReadings(ui, width) {
  const { t, r, mono } = ui;
  const items = (r.temp?.sensors ?? []).map((s) => ({ id: s.name.toLowerCase(), name: SHORT[s.name] ?? s.name, value: degrees(s.value), level: s.level }));
  if (r.fan && r.fan.rpm >= 1) items.push({ id: "fan", icon: "fan", value: rpm(r.fan.rpm).replace(" rpm", ""), level: r.fan.level });
  const out = [];
  let used = 0;
  for (const it of items) {
    const w = (it.icon ? 11 + 3 : it.name.length * 6.2 + 3) + it.value.length * 7;
    if (used + (out.length ? SENSOR_GAP : 0) + w > width) break;
    used += (out.length ? SENSOR_GAP : 0) + w;
    out.push(
      h_flex()
        .id(`sensor-${it.id}`)
        .flex_none()
        .gap(3)
        .items_center()
        .child(it.icon ? svg(ICON(it.icon)).size(11).flex_none().text_color(t.dim) : div().text_size(11).text_color(t.dim).child(it.name))
        .child(div().font_family(mono).text_size(11.5).text_color(textTone(t, it.level)).child(it.value)),
    );
  }
  if (!out.length) out.push(div().text_size(11).text_color(t.dim).child("No sensors"));
  return out;
}

function sensorTip(r) {
  const parts = (r.temp?.sensors ?? []).map((s) => `${s.name} ${degrees(s.value)}`);
  if (r.temp?.avg !== null && r.temp?.avg !== undefined) parts.splice(1, 0, `CPU average ${degrees(r.temp.avg)}`);
  if (r.fan) parts.push(r.fan.count > 1 ? `fastest fan ${rpm(r.fan.rpm)}` : `fan ${rpm(r.fan.rpm)}`);
  return parts.join(" · ") || "No sensors";
}

// ---------------------------------------------------------------------------
// The rail uses the panel's metric icons above their values.

export function rail(ui) {
  const { t, r, mono } = ui;
  const items = [];
  const add = (id, icon, value, fraction, kind, level, tip) =>
    items.push(
      v_flex()
        .id(`rail-${id}`)
        .items_center().flex_none()
        .gap(3)
        .role("button").accessibility_label(`${tip}, open System dashboard`).tooltip(tip)
        .cursor_pointer()
        .on_click(() => ui.act.dashboard())
        .child(svg(ICON(icon)).size(13).flex_none().text_color(t.muted))
        .child(div().font_family(mono).text_size(10.5).text_color(textTone(t, level)).child(value))
        .when(fraction !== null, (el) => el.child(bar(fraction, { width: 22, height: 3, color: tone(t, kind, level), track: track(t) }))),
    );
  if (r) {
    for (const m of ui.metrics) {
      if (m === "cpu") add("cpu", "cpu", pct(r.cpu.value).replace("%", ""), r.cpu.value, "cpu", r.cpu.level, cpuTip(r));
      if (m === "mem" && r.mem) add("mem", "memory", bytes(r.mem.used, { compact: true }), r.mem.fraction, "mem", r.mem.level, `Memory · ${memTip(r.mem)}`);
      if (m === "gpu" && r.gpu) add("gpu", "gpu", pct(r.gpu.value).replace("%", ""), r.gpu.value, "gpu", r.gpu.level, gpuTip(r.gpu));
      if (m === "net" && r.net) add("net", "net", rate(r.net.rx, { compact: true }), null, "rx", "ok", `Network ↓ ${rate(r.net.rx)}  ↑ ${rate(r.net.tx)}`);
      if (m === "disk" && r.disk) add("disk", "disk", pct(r.disk.fraction), r.disk.fraction, "disk", r.disk.level, `Disk · ${diskTip(r.disk)}`);
      if (m === "top" && ui.top) add("top", "terminal", coreLoad(ui.top.cpu), null, "cpu", "ok", `Busiest terminal: ${ui.top.name} · ${coreLoad(ui.top.cpu)} CPU`);
      if (m === "temp" && r.temp?.headline) add("temp", "temp", degrees(r.temp.headline), null, "temp", r.temp.level, `Temperature · ${sensorTip(r)}`);
    }
  }
  return v_flex()
    .id("root")
    .size_full()
    .bg(t.chrome)
    .border_t(1)
    .border_color(t.border)
    .items_center()
    .min_h(0).pt(4)
    .when(ui.fold, el => el.child(ui.fold))
    .on_size_change((size, cx) => ui.act.resized(size, cx))
    .when(!items.length, el => el.child(iconButton(ui, "rail-dashboard", "activity",
      ui.problem?.text ?? (r ? "Open System dashboard" : "Reading the machine…"), () => ui.act.dashboard())))
    .when(ui.stale && Boolean(r), (el) => el.opacity(0.55))
    .child(v_flex().id("stats-rail").w_full().flex_1().min_h(0).items_center().gap(8).py(4).overflow_y_scroll().children(items));
}

// ---------------------------------------------------------------------------
// The strip: one line, for the status bar or the end of the tab bar. Readings
// that don't fit the width are left out from the end of the person's order.

const STRIP_WIDTH = { cpu: 84, mem: 58, gpu: 52, net: 112, disk: 50, temp: 46, top: 150 };

export function stripItems(ui, width) {
  let room = width - 24;
  const out = [];
  for (const m of ui.metrics) {
    const w = STRIP_WIDTH[m];
    if (!w) continue;
    if (m === "mem" && !ui.r.mem) continue;
    if (m === "gpu" && !ui.r.gpu) continue;
    if (m === "net" && !ui.r.net) continue;
    if (m === "disk" && !ui.r.disk) continue;
    if (m === "temp" && !ui.r.temp?.headline) continue;
    if (m === "top" && !ui.top) continue;
    if (room - w < 0) continue;
    room -= w + 14;
    out.push(m);
  }
  return out;
}

export function strip(ui) {
  const { t, r, mono } = ui;
  const status = ui.spot === "status";
  const chip = (id, icon, kids, tip) =>
    h_flex()
      .id(`strip-${id}`)
      .h(20)
      .px(4)
      .gap(5)
      .flex_none()
      .items_center()
      .rounded(5)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => (id === "top" ? ui.act.go(ui.top) : ui.act.dashboard()))
      .tooltip(tip)
      .when(Boolean(icon), (el) => el.child(icon))
      .children(kids);
  const glyph = (name) => svg(ICON(name)).size(12).flex_none().text_color(t.dim);
  const val = (text, level) => div().font_family(mono).text_size(11.5).text_color(textTone(t, level)).child(text);
  const make = {
    cpu: () => chip("cpu", glyph("cpu"), [sparkline(r.cpu.hist, { width: 26, height: 11, color: tone(t, "cpu", r.cpu.level) }), val(pct(r.cpu.value), r.cpu.level)], cpuTip(r)),
    mem: () => chip("mem", glyph("memory"), [val(bytes(r.mem.used, { compact: true }), r.mem.level)], memTip(r.mem)),
    gpu: () => chip("gpu", glyph("gpu"), [val(pct(r.gpu.value), r.gpu.level)], gpuTip(r.gpu)),
    net: () =>
      chip(
        "net",
        null,
        [
          div().text_size(11).text_color(tone(t, "rx")).child("↓"),
          val(rate(r.net.rx, { compact: true }), "ok"),
          div().text_size(11).text_color(tone(t, "tx")).child("↑"),
          val(rate(r.net.tx, { compact: true }), "ok"),
        ],
        `↓ ${rate(r.net.rx)}  ↑ ${rate(r.net.tx)}`,
      ),
    disk: () => chip("disk", glyph("disk"), [val(pct(r.disk.fraction), r.disk.level)], diskTip(r.disk)),
    temp: () => chip("temp", glyph("temp"), [val(degrees(r.temp.headline), r.temp.level)], sensorTip(r)),
    top: () =>
      chip(
        "top",
        programIcon(ui.top.program, 12, t.muted),
        [div().max_w(84).truncate().text_size(11.5).text_color(t.muted).child(ui.top.name), val(coreLoad(ui.top.cpu), ui.top.cpu >= 2 ? "warn" : "ok")],
        `Busiest terminal: ${ui.top.name}${ui.top.where ? ` in ${ui.top.where}` : ""} · ${bytes(ui.top.rss)}. Click to go to it.`,
      ),
  };
  const items = r ? stripItems(ui, ui.width).map((m) => make[m]()) : [waiting(ui)];
  return h_flex()
    .id("root")
    .size_full()
    .px(10)
    .gap(9)
    .items_center()
    .justify_end()
    .bg(t.chrome)
    .when(status, (el) => el.border_t(1).border_color(t.border))
    .on_size_change((size, cx) => ui.act.resized(size, cx))
    .when(ui.stale && Boolean(r), (el) => el.opacity(0.55))
    .children(items)
    .when(ui.fold, el => el.child(ui.fold))
    .child(iconButton(ui, "strip-menu", "more", "Show in… and readings", () => ui.act.menu()));
}

// ---------------------------------------------------------------------------
// The floating drawer: chips on the edge side peek out; the details slide out on hover.

export function drawer(ui) {
  const { t, r, mono } = ui;
  const at = ui.placement;
  if (!at?.vertical) return strip({ ...ui, spot: "float", width: 420 });
  const right = at.edge === "right";
  const rows = [];
  const add = (id, label, value, level, detail) => {
    const chip = v_flex()
      .w(46)
      .flex_none()
      .items_center()
      .child(div().font_family(mono).text_size(11.5).text_color(textTone(t, level)).child(value))
      .child(div().text_size(9).text_color(t.dim).child(label));
    const more = h_flex().w(132).flex_none().items_center().child(detail);
    rows.push(
      h_flex()
        .id(`drawer-${id}`)
        .h(32)
        .gap(10)
        .items_center()
        .cursor_pointer()
        .on_click(() => ui.act.dashboard())
        // Herdr shows only `peek` px beside the edge: the figures go on that side.
        .children(right ? [more, chip] : [chip, more]),
    );
  };
  if (r) {
    for (const m of ui.metrics) {
      if (m === "cpu") add("cpu", "cpu", pct(r.cpu.value), r.cpu.level, sparkline(r.cpu.hist, { width: 132, height: 18, color: tone(t, "cpu", r.cpu.level) }));
      if (m === "mem" && r.mem) add("mem", "mem", bytes(r.mem.used, { compact: true }), r.mem.level, memoryBar(t, r.mem, 132, 6));
      if (m === "gpu" && r.gpu) add("gpu", "gpu", pct(r.gpu.value), r.gpu.level, sparkline(r.gpu.hist, { width: 132, height: 18, color: tone(t, "gpu", r.gpu.level) }));
      if (m === "net" && r.net) add("net", "net", rate(Math.max(r.net.rx, r.net.tx), { compact: true }), "ok", mirrored(r.net.rxHist, r.net.txHist, { width: 132, height: 20, upColor: tone(t, "rx"), downColor: tone(t, "tx") }));
      if (m === "temp" && r.temp?.headline) add("temp", "temp", degrees(r.temp.headline), r.temp.level, div().text_size(11).text_color(t.dim).child(sensorTip(r)).truncate());
    }
  }
  return v_flex()
    .id("root")
    .py(4)
    .px(6)
    .gap(2)
    .when(!r, (el) => el.child(waiting(ui)))
    .when(ui.stale && Boolean(r), (el) => el.opacity(0.55))
    .children(rows);
}

// ---------------------------------------------------------------------------
// The dashboard: every reading with room to read it, and who is using the machine.

function section(t, title, value, valueLevel, detail, body) {
  return v_flex()
    .gap(8)
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(title))
        .when(value !== null && value !== undefined, (el) => el.child(div().text_size(12.5).font_semibold().text_color(textTone(t, valueLevel)).child(value)))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(detail ?? "")),
    )
    .children(body);
}

function legend(t, items) {
  return h_flex()
    .flex_wrap()
    .gap_x(12)
    .gap_y(4)
    .text_size(11)
    .text_color(t.muted)
    .children(items.map(([color, label, value]) => h_flex().gap(5).items_center().child(div().size(7).rounded(2).bg(color)).child(label).child(div().text_color(t.foreground).child(value))));
}

function chartFrame(t, width, height, chart, marks = [0.5]) {
  return div()
    .relative()
    .w(width)
    .h(height)
    .flex_none()
    .children(marks.map((m) => div().absolute().left(0).top(Math.round(height * (1 - m))).w(width).h(1).bg(alpha(t.foreground, 0.06))))
    .child(chart);
}

export function cpuSection(ui, width) {
  const { t, r } = ui;
  const detail = [r.cpu.p !== null && r.cpu.e !== null ? `performance ${pct(r.cpu.p)} · efficiency ${pct(r.cpu.e)}` : null, `busiest core ${pct(r.cpu.max)}`, r.load ? `load ${r.load.map((v) => v.toFixed(2)).join(" ")}` : null]
    .filter(Boolean)
    .join(" · ");
  const { cells, split } = poolCores(r.cpu.cores, cellsIn(width, 8, 3), r.cpu.pcores);
  const colorOf = (v) => tone(t, "cpu", v >= 0.9 ? "crit" : v >= 0.7 ? "warn" : "ok");
  return section(t, "CPU", pct(r.cpu.value), r.cpu.level, detail, [
    chartFrame(t, width, 64, sparkline(r.cpu.hist, { width, height: 64, bar: 3, gap: 1, color: tone(t, "cpu", r.cpu.level) }), [0.5, 1]),
    coreCells(cells, split, { width, height: 22, gap: 3, clusterGap: 10, track: track(t), colorOf }),
    split
      ? h_flex()
          .text_size(10.5)
          .text_color(t.dim)
          .child(div().w(Math.round((width * split) / cells.length)).flex_none().child(`${r.cpu.pcores} performance`))
          .child(div().child(`${r.cpu.cores.length - r.cpu.pcores} efficiency`))
      : div().text_size(10.5).text_color(t.dim).child(`${r.cpu.cores.length} cores`),
  ]);
}

export function memSection(ui, width) {
  const { t } = ui;
  const m = ui.r.mem;
  const base = tone(t, "mem", m.level);
  const free = Math.max(0, m.total - m.used);
  return section(t, "Memory", `${bytes(m.used)} of ${bytes(m.total)}`, m.level, m.pressure !== null ? `pressure ${pct(m.pressure)}` : "", [
    memoryBar(t, m, width, 8),
    legend(t, [
      [base, "App", bytes(m.app)],
      [alpha(base, 0.7), "Wired", bytes(m.wired)],
      [alpha(base, 0.42), "Compressed", bytes(m.compressed)],
      [track(t), "Free", bytes(free)],
      ...(m.swap ? [[alpha(t.ansi3 ?? t.working, 0.8), "Swap", bytes(m.swap)]] : []),
    ]),
    chartFrame(t, width, 28, sparkline(m.hist, { width, height: 28, bar: 3, gap: 1, color: alpha(base, 0.9) })),
  ]);
}

export function gpuSection(ui, width) {
  const { t } = ui;
  const g = ui.r.gpu;
  return section(t, "GPU", pct(g.value), g.level, g.memory ? `${bytes(g.memory)} in use` : "", [
    chartFrame(t, width, 36, sparkline(g.hist, { width, height: 36, bar: 3, gap: 1, color: tone(t, "gpu", g.level) })),
  ]);
}

export function netSection(ui, width) {
  const { t } = ui;
  const n = ui.r.net;
  const peak = Math.max(64 * 1024, ...n.rxHist, ...n.txHist);
  return section(t, "Network", null, "ok", `peak ${rate(peak)}`, [
    h_flex()
      .gap(16)
      .text_size(11.5)
      .child(h_flex().gap(5).child(div().text_color(tone(t, "rx")).child("↓")).child(div().font_family(ui.mono).text_color(t.foreground).child(rate(n.rx))).child(div().text_color(t.dim).child("in")))
      .child(h_flex().gap(5).child(div().text_color(tone(t, "tx")).child("↑")).child(div().font_family(ui.mono).text_color(t.foreground).child(rate(n.tx))).child(div().text_color(t.dim).child("out"))),
    mirrored(n.rxHist, n.txHist, { width, height: 44, bar: 3, gap: 1, upColor: tone(t, "rx"), downColor: tone(t, "tx"), scale: peak }),
  ]);
}

export function diskSection(ui, width) {
  const { t } = ui;
  const d = ui.r.disk;
  return section(t, "Disk", `${bytes(d.used)} of ${bytes(d.total)}`, d.level, `${bytes(d.available)} free`, [
    bar(d.fraction, { width, height: 8, color: tone(t, "disk", d.level), track: track(t) }),
  ]);
}

export function sensorSection(ui, width) {
  const { t, r } = ui;
  const chips = (r.temp?.sensors ?? []).map((s) => [s.name, degrees(s.value), s.level]);
  if (r.temp?.avg !== null && r.temp?.avg !== undefined && chips.length) chips.splice(1, 0, ["CPU average", degrees(r.temp.avg), "ok"]);
  if (r.fan) chips.push([r.fan.count > 1 ? "Fastest fan" : "Fan", rpm(r.fan.rpm), r.fan.level]);
  return section(t, "Sensors", null, "ok", "", [
    h_flex()
      .w(width)
      .flex_wrap()
      .gap(6)
      .children(
        chips.map(([name, value, level]) =>
          h_flex()
            .h(26)
            .px(9)
            .gap(6)
            .items_center()
            .rounded(7)
            .bg(alpha(t.foreground, 0.05))
            .text_size(11.5)
            .child(div().text_color(t.muted).child(name))
            .child(div().font_family(ui.mono).text_color(textTone(t, level)).child(value)),
        ),
      ),
  ]);
}

const COLS = { cpu: 56, mem: 64, procs: 40 };

export function terminalSection(ui, width) {
  const { t, mono } = ui;
  const rows = ui.rows;
  if (!ui.r.terms) {
    return section(t, "Terminals", null, "ok", "", [div().text_size(11.5).text_color(t.dim).child(ui.r.os === "linux" && ui.source === "proc" ? "Per-terminal use needs the sampler." : "Waiting for herdr-core…")]);
  }
  const total = rows.reduce((a, x) => ({ cpu: a.cpu + x.cpu, rss: a.rss + x.rss }), { cpu: 0, rss: 0 });
  // Narrow (a right sidebar): CPU only, so the names keep their room; the rest is in the tooltip.
  const wide = width >= 380;
  const head = h_flex()
    .h(22)
    .px(8)
    .items_center()
    .text_size(10.5)
    .text_color(t.dim)
    .child(div().flex_1().child("By CPU"))
    .child(div().w(COLS.cpu).text_right().child("CPU"))
    .when(wide, (el) => el.child(div().w(COLS.mem).text_right().child("Memory")).child(div().w(COLS.procs).text_right().child("Procs")));
  const list = rows.slice(0, 14).map((x, i) =>
    h_flex()
      .id(`term-${x.address}`)
      .h(30)
      .px(8)
      .gap(8)
      .items_center()
      .rounded(7)
      .text_size(12)
      .cursor_pointer()
      .when(i === ui.sel, (el) => el.bg(t.selected))
      .when(x.focused && i !== ui.sel, (el) => el.bg(alpha(t.foreground, 0.04)))
      .hover((s) => s.bg(t.hover))
      .on_click(() => ui.act.go(x))
      .tooltip(`${x.name}${x.title ? ` — ${x.title}` : ""} · ${coreLoad(x.cpu)} CPU · ${bytes(x.rss)} · ${x.procs} processes${x.process ? ` · busiest: ${x.process}` : ""}`)
      .child(programIcon(x.program, 14, t.muted))
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .overflow_hidden()
          .gap(6)
          .items_center()
          // The name keeps its room; "space › tab", then the title, give way (ellipsis) first.
          .child(div().flex_shrink_0().max_w(140).truncate().text_color(t.foreground).child(x.name))
          .when(Boolean(x.where), (el) => el.child(div().flex_shrink_1().min_w(0).max_w(150).truncate().text_color(t.muted).child(x.where)))
          .when(Boolean(x.title), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(x.title))),
      )
      .child(div().w(COLS.cpu).flex_none().text_right().font_family(mono).text_color(textTone(t, x.cpu >= 2 ? "warn" : "ok")).child(coreLoad(x.cpu)))
      .when(wide, (el) =>
        el
          .child(div().w(COLS.mem).flex_none().text_right().font_family(mono).text_color(t.muted).child(bytes(x.rss, { compact: true })))
          .child(div().w(COLS.procs).flex_none().text_right().font_family(mono).text_color(t.dim).child(String(x.procs))),
      ),
  );
  return section(t, "Terminals", null, "ok", rows.length ? `${rows.length} · ${coreLoad(total.cpu)} CPU · ${bytes(total.rss)}` : "none running", [
    v_flex().w(width).child(head).children(list).when(!rows.length, (el) => el.child(div().px(8).text_size(11.5).text_color(t.dim).child("No terminals on this computer."))),
  ]);
}

export function processSection(ui, width) {
  const { t, mono } = ui;
  const top = ui.r.top;
  const body = !top
    ? [div().text_size(11.5).text_color(t.dim).child(ui.source === "proc" ? "Needs the sampler." : "Gathering…")]
    : [
        v_flex()
          .w(width)
          .children(
            top.slice(0, 10).map((p) =>
              h_flex()
                .h(24)
                .px(8)
                .gap(8)
                .items_center()
                .text_size(11.5)
                .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(p.name))
                .child(div().w(COLS.cpu).flex_none().text_right().font_family(mono).text_color(textTone(t, p.cpu >= 2 ? "warn" : "ok")).child(coreLoad(p.cpu)))
                .child(div().w(COLS.mem).flex_none().text_right().font_family(mono).text_color(t.muted).child(bytes(p.rss, { compact: true })))
                .child(div().w(COLS.procs).flex_none().text_right().font_family(mono).text_color(t.dim).child(String(p.pid))),
            ),
          ),
      ];
  return section(t, "Busiest processes", null, "ok", "yours, by CPU", body);
}

function sections(ui, width, which) {
  const { r } = ui;
  const out = [];
  for (const s of which) {
    if (s === "cpu") out.push(cpuSection(ui, width));
    if (s === "mem" && r.mem) out.push(memSection(ui, width));
    if (s === "gpu" && r.gpu) out.push(gpuSection(ui, width));
    if (s === "net" && r.net) out.push(netSection(ui, width));
    if (s === "disk" && r.disk) out.push(diskSection(ui, width));
    if (s === "temp" && (r.temp || r.fan)) out.push(sensorSection(ui, width));
    if (s === "terms") out.push(terminalSection(ui, width));
    if (s === "procs") out.push(processSection(ui, width));
  }
  return out;
}

export function dashboard(ui) {
  const { t, r } = ui;
  const pad = 22;
  const twoColumns = ui.width >= 760;
  const inner = Math.max(200, ui.width - pad * 2);
  const leftW = twoColumns ? Math.floor((inner - 28) * 0.5) : inner;
  const rightW = twoColumns ? inner - 28 - leftW : inner;
  const subtitle = r ? [r.host, r.uptime !== null ? `up ${uptime(r.uptime)}` : null, ui.stale ? "paused" : "live"].filter(Boolean).join(" · ") : "";
  const header = h_flex()
    .h(56)
    .px(pad)
    .flex_none()
    .gap(10)
    .items_center()
    .border_b(1)
    .border_color(t.border)
    .child(svg(ICON("activity")).size(16).flex_none().text_color(t.muted))
    .child(div().text_size(15).font_semibold().text_color(t.foreground).child("System"))
    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(subtitle))
    .child(
      h_flex()
        .id("show-in")
        .h(28)
        .px(10)
        .gap(6)
        .items_center()
        .rounded(7)
        .text_size(12)
        .cursor_pointer()
        // Not placed anywhere yet (just installed): this is the next step, so it's the filled button.
        .when(ui.placed !== false, (el) => el.border(1).border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .when(ui.placed === false, (el) => el.bg(t.solid ?? t.accent).text_color(t.solid_foreground ?? t.background).font_medium())
        .on_click(() => ui.act.menu())
        .tooltip(ui.placed === false ? "Keep the stats in a sidebar, a bar or a drawer" : "Where the stats show, and which readings")
        .child(svg(ICON("panel-left")).size(13))
        .child("Show in…"),
    )
    .when(ui.fold, el => el.child(ui.fold))
    .when(Boolean(ui.overlay), (el) => el.child(iconButton(ui, "close", "x", "Close  esc", () => ui.act.close())));
  const left = ["cpu", "mem", "gpu", "net", "disk", "temp"];
  const right = ["terms", "procs"];
  const body = !r
    ? [v_flex().p(pad).child(waiting(ui))]
    : twoColumns
      ? [h_flex().px(pad).py(18).gap(28).items_start().child(v_flex().w(leftW).flex_none().gap(22).children(sections(ui, leftW, left))).child(v_flex().w(rightW).flex_none().gap(22).children(sections(ui, rightW, right)))]
      : [v_flex().px(pad).py(18).gap(22).children(sections(ui, inner, [...left.slice(0, 2), "terms", ...left.slice(2), "procs"]))];
  const footer = h_flex()
    .h(34)
    .px(pad)
    .flex_none()
    .gap(14)
    .items_center()
    .border_t(1)
    .border_color(t.border)
    .text_size(11)
    .text_color(t.dim)
    .child(div().child("↑↓ choose"))
    .child(div().child("⏎ go to it"))
    .when(Boolean(ui.overlay), (el) => el.child(div().child("esc close")))
    .child(div().flex_1())
    .child(div().child(ui.footnote ?? ""));
  return v_flex()
    .id("root")
    .size_full()
    .min_h(0)
    .bg(ui.overlay ? t.popover ?? t.background : t.background)
    .track_focus(ui.handle)
    .on_key_down((e, cx) => ui.act.key(e, cx))
    .on_size_change((size, cx) => ui.act.resized(size, cx))
    .child(header)
    .child(v_flex().id("dash-scroll").flex_1().min_h(0).overflow_y_scrollbar().when(ui.stale && Boolean(r), (el) => el.opacity(0.6)).children(body))
    .child(footer);
}

/** A tall column (a right sidebar of its own, a pane): the dashboard's sections, one under another. */
export function column(ui) {
  const { t, r } = ui;
  const pad = 16;
  const inner = Math.max(120, ui.width - pad * 2);
  return v_flex()
    .id("root")
    .size_full()
    .min_h(0)
    .bg(t.chrome)
    .on_size_change((size, cx) => ui.act.resized(size, cx))
    .child(
      h_flex()
        .px(pad)
        .h(41)
        .pt(14)
        .pb(5)
        .flex_none()
        .items_center()
        .gap(6)
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("System"))
        .when(Boolean(r?.host), (el) => el.child(div().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(`· ${r.host}`)))
        .child(div().flex_1())
        .when(ui.fold, el => el.child(ui.fold))
        .child(iconButton(ui, "open-dashboard", "expand", `Open the dashboard${ui.dashKey ? `  ${ui.dashKey}` : ""}`, () => ui.act.dashboard()))
        .child(iconButton(ui, "panel-menu", "more", "Show in… and readings", () => ui.act.menu())),
    )
    .child(
      v_flex()
        .id("column-scroll")
        .flex_1()
        .min_h(0)
        .px(pad)
        .pb(14)
        .gap(20)
        .overflow_y_scrollbar()
        .when(ui.stale && Boolean(r), (el) => el.opacity(0.55))
        .children(r ? sections(ui, inner, [...ui.metrics.filter((m) => m !== "top"), ...(ui.metrics.includes("top") ? ["terms"] : [])]) : [waiting(ui)]),
    );
}

// ---------------------------------------------------------------------------
// The menu: where the stats show (each place on or off) and which readings.

export function menu(ui) {
  const { t } = ui;
  const title = (text) => div().px(8).pt(6).pb(4).text_size(11).text_color(t.dim).child(text);
  const check = (on) => (on ? svg(ICON("check")).size(13).flex_none().text_color(t.foreground) : div().size(13).flex_none());
  const item = (id, icon, label, on, enabled, tip, click, hint) =>
    h_flex()
      .id(id)
      .h(29)
      .px(8)
      .gap(9)
      .flex_none()
      .rounded(7)
      .items_center()
      .text_size(12.5)
      .text_color(enabled ? t.foreground : t.dim)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => click(cx)))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .when(Boolean(icon), (el) => el.child(svg(ICON(icon)).size(14).flex_none().text_color(enabled ? t.muted : t.dim)))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(hint)))
      .child(check(on));
  const spots = SPOTS.map((s) => {
    const state = ui.spots[s.id];
    return item(`spot-${s.id}`, s.icon, s.label, state.on, state.enabled, state.enabled ? s.about : state.why, () => ui.act.place(s.id));
  });
  const readings = METRICS.map((m) => item(`metric-${m.id}`, null, m.label, ui.metrics.includes(m.id), true, m.about, () => ui.act.metric(m.id)));
  return v_flex()
    .id("root")
    .when(!ui.width, (el) => el.w_full())
    .when(Boolean(ui.width), (el) => el.w(ui.width))
    .p(5)
    .bg(t.popover)
    .child(title("Show system stats in"))
    .children(spots)
    .when(Boolean(ui.note), (el) => el.child(div().px(8).pt(4).pb(2).text_size(11).text_color(t.dim).child(ui.note)))
    .child(div().h(1).mx(4).my(5).bg(t.border))
    .child(title("Readings"))
    .children(readings)
    .child(div().h(1).mx(4).my(5).bg(t.border))
    .child(item("menu-dashboard", "expand", "Open dashboard", false, true, null, () => ui.act.dashboard(), ui.dashKey));
}

export { busiest };
