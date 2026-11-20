// herdr-stats: this machine's CPU, memory, GPU, network, disk and sensors, and which
// terminal is using them. One mod, many looks: it reads where it was put (a
// sidebar, a bar, a drawer, a dialog) and how much room it has, and draws to fit.

import { sidebarButton } from "./sidebar-rail.js";
import { View } from "gpui-kit";
import {
  exec,
  readTextFile,
  appHome,
  home,
  theme,
  settings,
  props,
  placement,
  window,
  layout,
  layouts,
  shared,
  setShared,
  run,
  openOverlay,
  closeOverlay,
  panes,
  agents,
  spaces,
  terminals,
  keys,
} from "herdr";
import { sharedFeed } from "./feed.js";
import { readings, terminalRows, busiest, DEFAULT_METRICS, METRICS } from "./model.js";
import { MOD, SPOTS, SIZES, spotsIn, available, toggleSpot, copyName, blockId, findNode } from "./placement.js";
import { chord } from "./format.js";
import * as views from "./views.js";

const METRICS_KEY = "herdr-stats.metrics";
const SHIPPED = ["main", "terminals", "win98"]; // until installed.json says otherwise
const MENU = { width: 270, height: 486 };
const DEFAULT_SIZE = { left: [268, SIZES.left], right: [300, SIZES.right], status: [SIZES.status, 28], tabs: [SIZES.tabs, 42], float: [200, 200] };

export function chosenMetrics() {
  const saved = shared(METRICS_KEY);
  if (!Array.isArray(saved)) return DEFAULT_METRICS.slice();
  const known = new Set(METRICS.map((m) => m.id));
  return METRICS.map((m) => m.id).filter((id) => known.has(id) && saved.includes(id));
}

export default class Stats extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.view = p.view ?? (p.overlay ? "dashboard" : null);
    this.size = null;
    this.sel = 0;
    this.seen = null;
    this.drawnAt = 0;
    this.shipped = new Set(SHIPPED);
    cx.spawn(async () => {
      const text = await readTextFile(`${appHome()}/installed.json`).catch(() => null);
      try {
        if (text) this.shipped = new Set(Object.keys(JSON.parse(text)).filter((k) => k.startsWith("layout:")).map((k) => k.slice(7)));
      } catch {
        // keep the fallback list
      }
    });
    // The menu reads the feed (to size panels to their readings) but doesn't keep it running.
    this.feed = sharedFeed(() => this.deps());
    if (this.view === "menu") return;

    this.handle = cx.focus_handle();
    if (this.view === "dashboard") {
      cx.spawn(async (cx) => {
        await cx.sleep(30);
        this.handle.focus();
      });
    }
    cx.timer.every(1000, (cx) => this.tick(cx));
    this.tick(cx);
  }

  deps() {
    const platform = window()?.platform ?? "macos";
    return {
      exec,
      readTextFile,
      now: () => Date.now(),
      platform,
      interval: 1000,
      dir: platform === "macos" ? `${home()}/Library/Caches/herdr-stats` : `${home()}/.cache/herdr-stats`,
      // Herdr's macOS build is Apple Silicon only, and so is this binary. Linux reads /proc.
      bin: platform === "macos" ? `${appHome()}/mods/herdr-stats/bin/herdr-stats-sampler` : null,
    };
  }

  // Once a second: start the sampler if it went quiet, read the snapshot, and
  // redraw only when there is something new to draw. With the window in the
  // background a sidebar redraws at most every 5 s: every redraw repaints the
  // whole window, and nobody is reading it.
  tick(cx) {
    this.feed.ensure((body) => cx.spawn(body));
    this.feed.checkIn();
    cx.spawn(async (cx) => {
      const snap = await this.feed.read();
      if (this.view === "dashboard") this.feed.wantDetail();
      const key = snap ? `${snap.t}:${this.feed.stale()}` : `none:${this.feed.error ?? ""}:${this.feed.launches}`;
      if (key === this.seen) return;
      const now = Date.now();
      const away = window()?.active === false && this.view !== "dashboard";
      if (snap && this.seen && away && now - this.drawnAt < 5000) return;
      this.seen = key;
      this.drawnAt = now;
      cx.notify();
    });
  }

  // No close(): the sampler exits by itself 30 s after the last copy stops checking in.

  // ---- what to draw -------------------------------------------------------

  variant(width, height) {
    if (this.view === "menu") return "menu";
    if (this.view === "dashboard") return "dashboard";
    if (placement()) return "drawer";
    const spot = props()?.spot;
    if (spot === "status" || spot === "tabs") return "strip";
    if (width < 150) return "rail";
    if (height < 64) return "strip";
    if (width >= 640 && height >= 380) return "dashboard";
    if (height >= 440) return "column";
    return "panel";
  }

  problem() {
    const f = this.feed;
    if (!f) return null;
    if (f.source === "none") return { text: "Needs macOS or Linux", detail: "There is no sampler for this system yet." };
    if (f.error && f.stale()) return { text: "The sampler didn't start", detail: f.error };
    return null;
  }

  ui(t) {
    const s = settings() ?? {};
    const zoom = Number(s.zoom) > 0 ? Number(s.zoom) : 1;
    const spot = props()?.spot;
    const [dw, dh] = DEFAULT_SIZE[spot] ?? [this.view === "dashboard" ? 860 : 268, this.view === "dashboard" ? 640 : SIZES.left];
    const width = this.size ? this.size.width / zoom : dw;
    const height = this.size ? this.size.height / zoom : dh;
    const snap = this.feed?.snap ?? null;
    const r = readings(snap);
    const world = { panes: panes(), agents: agents(), spaces: spaces(), terminals: terminals() };
    const rows = r?.terms ? terminalRows(r.terms, world) : [];
    if (this.sel >= rows.length) this.sel = Math.max(0, rows.length - 1);
    const mac = window()?.platform === "macos";
    const binding = keys().find((k) => k.section === "global" && k.action === `mod.open:${MOD}`);
    return {
      t,
      mono: s.font_family ?? s.font ?? "JetBrains Mono",
      r,
      rows,
      top: busiest(rows),
      width,
      height,
      spot,
      stale: this.feed ? this.feed.stale() : false,
      problem: this.problem(),
      source: this.feed?.source,
      metrics: chosenMetrics(),
      dashKey: binding ? chord(binding.keys, mac) : "",
      placement: placement(),
      placed: this.view === "dashboard" ? spotsIn(layout()).size > 0 : true,
      overlay: props()?.overlay ?? null,
      sel: this.sel,
      handle: this.handle,
      footnote: snap?.version ? `herdr-stats-sampler ${snap.version} · every ${Math.round((snap.interval ?? 1000) / 1000)} s` : this.feed?.source === "proc" ? "read from /proc" : "",
      act: this.actions(rows),
    };
  }

  actions(rows) {
    return {
      dashboard: () => this.openDashboard(),
      menu: () => this.openMenu(),
      close: () => props()?.overlay && closeOverlay(props().overlay),
      go: (row) => this.go(row),
      key: (e, cx) => this.key(e, cx, rows),
      resized: (size, cx) => {
        const old = this.size;
        if (old && Math.abs(old.width - size.width) < 1 && Math.abs(old.height - size.height) < 1) return;
        this.size = size;
        cx.notify();
      },
      place: (spot) => this.place(spot),
      metric: (id) => this.toggleMetric(id),
    };
  }

  openDashboard() {
    if (this.view === "dashboard") return;
    if (this.view === "menu" && props()?.overlay) closeOverlay(props().overlay);
    run("mod.open", { name: MOD });
  }

  openMenu() {
    openOverlay({ mod: MOD, kind: "popup", width: MENU.width, height: MENU.height, props: { view: "menu" } });
  }

  go(row) {
    if (!row) return;
    if (row.pane) run("pane.focus", { terminal: row.address });
    else run("terminal.peek", { terminal: row.address });
    if (this.view === "dashboard" && props()?.overlay) closeOverlay(props().overlay);
  }

  key(e, cx, rows) {
    const k = e.key;
    if (k === "down" || k === "j") this.sel = Math.min(rows.length - 1, this.sel + 1);
    else if (k === "up" || k === "k") this.sel = Math.max(0, this.sel - 1);
    else if (k === "enter") return this.go(rows[this.sel]);
    else if (k === "escape") return props()?.overlay && closeOverlay(props().overlay);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ---- where it shows -----------------------------------------------------

  spotStates() {
    const tree = layout();
    const on = spotsIn(tree);
    const out = {};
    for (const s of SPOTS) {
      const enabled = on.has(s.id) || available(tree, s.id);
      out[s.id] = { on: on.has(s.id), enabled, why: enabled ? null : "This layout has no place for it" };
    }
    return out;
  }

  place(spot) {
    const name = shared("layout");
    let tree = layout();
    const adding = !spotsIn(tree).has(spot);
    // Herdr's own layouts are replaced on every start: the stats go into a copy.
    if (typeof name === "string" && this.shipped.has(name)) {
      if (!adding) return;
      run("layout.clone", { name, as: copyName(name, layouts()) });
      tree = layout();
    }
    const next = toggleSpot(tree, spot);
    if (next) run("layout.set", { layout: next });
  }

  toggleMetric(id) {
    const now = chosenMetrics();
    const next = now.includes(id) ? now.filter((m) => m !== id) : [...now, id];
    setShared(METRICS_KEY, METRICS.map((m) => m.id).filter((m) => next.includes(m)));
    this.fitPanels();
  }

  // The left panel grows or shrinks to the readings it now shows. Not the right one:
  // it draws the scrolling column and shares its sidebar by weight (placement.js).
  fitPanels() {
    const tree = layout();
    const r = readings(this.feed?.snap ?? null);
    if (!r) return;
    for (const spot of ["left"]) {
      const id = blockId(spot);
      const hit = findNode(tree, (n) => n.id === id);
      if (!hit || hit.parent?.type !== "column" || hit.parent.children.length < 2) continue;
      const px = views.panelHeight({ r, metrics: chosenMetrics(), top: r.terms ? {} : null });
      run("layout.resize", { id, px });
    }
  }

  render() {
    const t = theme();
    if (this.view === "menu") {
      const name = shared("layout");
      const copying = typeof name === "string" && this.shipped.has(name);
      return views.menu({
        t,
        // In its popup the menu fills it; placed anywhere else (a floating block) it keeps its width.
        width: props()?.overlay ? null : MENU.width,
        spots: this.spotStates(),
        metrics: chosenMetrics(),
        note: copying ? `Herdr's own layouts are read-only, so your first pick makes a copy (${copyName(name, layouts())}) and shows it.` : null,
        dashKey: (() => {
          const b = keys().find((k) => k.section === "global" && k.action === `mod.open:${MOD}`);
          return b ? chord(b.keys, window()?.platform === "macos") : "";
        })(),
        act: {
          place: (spot) => this.place(spot),
          metric: (id) => this.toggleMetric(id),
          dashboard: () => this.openDashboard(),
        },
      });
    }
    const ui = this.ui(t);
    const variant = this.variant(ui.width, ui.height);
    if (!this.view && !ui.placement && !["status", "tabs"].includes(ui.spot)) {
      ui.fold = sidebarButton(MOD, ui.width);
    }
    switch (variant) {
      case "dashboard":
        return views.dashboard(ui);
      case "drawer":
        return views.drawer(ui);
      case "strip":
        return views.strip(ui);
      case "rail":
        return views.rail(ui);
      case "column":
        return views.column(ui);
      default:
        return views.panel(ui);
    }
  }
}
