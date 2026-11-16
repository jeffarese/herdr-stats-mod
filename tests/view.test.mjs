// The real views and their handlers, drawn into an in-memory builder (tests/stubs).
// This checks what is drawn and what clicks do; `herdr-app check` and a look in the
// app check that GPUI accepts it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { world } from "herdr";
import { byId, ids, text, nodes } from "gpui-kit";
import Stats from "../mods/herdr-stats/main.js";
import * as views from "../mods/herdr-stats/views.js";
import { readings } from "../mods/herdr-stats/model.js";

const SNAP_TEXT = readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8");
const MAIN = JSON.parse(readFileSync(new URL("./fixtures/layout-main.json", import.meta.url), "utf8"));
const SNAP_PATH = "/home/me/Library/Caches/herdr-stats/snapshot.json";

function reset(props = {}) {
  Object.assign(world, {
    props,
    placement: null,
    layout: structuredClone(MAIN),
    layoutName: "mine",
    layouts: ["main", "mine"],
    shared: {},
    runs: [],
    overlays: [],
    closed: [],
    execs: [],
    files: { [SNAP_PATH]: SNAP_TEXT.replace(/"t": \d+/, `"t": ${Date.now()}`) },
    window: { platform: "macos", active: true },
    spaces: [{ id: "s1", name: "api", tabs: [{ id: "tb1", name: "tests" }] }],
    panes: [{ pane: "p1", terminal: "t4", tab: "tb1", title: "Retry the flaky auth test", program: { name: "Claude Code", agent: true }, focused: false }],
    agents: [{ address: "t4", pane: "p1", tab: "tb1", title: "Retry the flaky auth test", status: "working", program: { name: "Claude Code", agent: true } }],
    terminals: [{ address: "t7", parent: "t4", name: "build", program: { name: "cargo" } }],
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
}

function cx() {
  const c = {
    tasks: [],
    notified: 0,
    timers: [],
    spawn(body) {
      const p = Promise.resolve().then(() => body(c));
      c.tasks.push(p);
      return { cancel() {}, is_done: () => false };
    },
    timer: { every: (ms, fn) => c.timers.push({ ms, fn }), after: () => {} },
    focus_handle: () => ({ focus() {} }),
    notify() {
      c.notified++;
    },
    sleep: async () => {},
    stop_propagation() {
      c.stopped = true;
    },
  };
  c.settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.all(c.tasks.splice(0));
  };
  return c;
}

async function mount(props = {}, size = null) {
  reset(props);
  const view = new Stats();
  const c = cx();
  view.init(props, c);
  await c.settle();
  if (size) view.size = size;
  return { view, c, draw: () => view.render(c) };
}

test("a sidebar panel shows one line per reading, in the person's order", async () => {
  const { draw } = await mount({ spot: "left" }, { width: 268, height: 260 });
  const tree = draw();
  assert.deepEqual(ids(tree).filter((i) => i.startsWith("row-")), ["row-cpu", "row-mem", "row-gpu", "row-net", "row-temp", "row-top"]);
  assert.match(text(byId(tree, "row-cpu")), /37%/);
  assert.match(text(byId(tree, "row-mem")), /42\.4G/);
  assert.match(byId(tree, "row-cpu").tip, /busiest core 92% · performance 42% · efficiency 31%/);
});

test("the busiest-terminal line names it and goes there on click", async () => {
  const { draw } = await mount({ spot: "left" }, { width: 268, height: 260 });
  const top = byId(draw(), "row-top");
  assert.match(text(top), /cargo/);
  assert.match(text(top), /214%/);
  top.handlers.on_click();
  assert.deepEqual(world.runs.at(-1), ["terminal.peek", { terminal: "t7" }], "a sub-agent has no pane: peek");
});

test("a short panel drops the lines that don't fit, the core cells first", async () => {
  // 130 px leaves 79 for lines: three readings (75) fit only without the core cells (+14).
  const { draw } = await mount({ spot: "left" }, { width: 268, height: 130 });
  const tree = draw();
  assert.deepEqual(ids(tree).filter((i) => i.startsWith("row-")), ["row-cpu", "row-mem", "row-gpu"]);
  assert.ok(![...nodes(tree)].some((n) => n.calls.some((c) => c[0] === "h" && c[1] === 11)), "no core-cell row");
});

test("zoom is divided out of the reported size", async () => {
  const { view, draw } = await mount({ spot: "left" }, { width: 268 * 0.5, height: 130 * 0.5 });
  world.settings = { ...world.settings, zoom: 0.5 };
  try {
    const rows = ids(draw()).filter((i) => i.startsWith("row-"));
    assert.ok(rows.length >= 2, "at zoom 0.5 a 134x65 report is a 268x130 panel");
    assert.equal(view.variant(268, 130), "panel");
  } finally {
    world.settings = { ...world.settings, zoom: 1 };
  }
});

test("the look follows the room: rail, strip, panel, column, dashboard", async () => {
  const { view } = await mount({ spot: "left" });
  assert.equal(view.variant(60, 600), "rail");
  assert.equal(view.variant(400, 30), "strip");
  assert.equal(view.variant(268, 220), "panel");
  assert.equal(view.variant(300, 700), "column");
  assert.equal(view.variant(900, 600), "dashboard");
  const bar = await mount({ spot: "status" });
  assert.equal(bar.view.variant(380, 400), "strip", "a bar spot is a strip whatever its size");
  reset({ spot: "float" });
  world.placement = { edge: "right", align: "end", vertical: true, hovered: false, dragging: false };
  assert.equal(view.variant(200, 200), "drawer");
  world.placement = null;
});

test("the strip fits what the width allows, in order", async () => {
  const { draw, view } = await mount({ spot: "status" }, { width: 380, height: 28 });
  const tree = draw();
  const chips = ids(tree).filter((i) => i.startsWith("strip-") && i !== "strip-menu");
  assert.deepEqual(chips.slice(0, 3), ["strip-cpu", "strip-mem", "strip-gpu"]);
  view.size = { width: 150, height: 28 };
  assert.deepEqual(ids(draw()).filter((i) => i.startsWith("strip-") && i !== "strip-menu"), ["strip-cpu"]);
});

test("the rail shows numbers without units where every column is precious", async () => {
  const { draw } = await mount({ spot: "left" }, { width: 60, height: 500 });
  const tree = draw();
  assert.deepEqual(ids(tree).filter((i) => i.startsWith("rail-")), ["rail-cpu", "rail-mem", "rail-gpu", "rail-temp"]);
  assert.match(text(byId(tree, "rail-cpu")), /^37 /);
});

test("the dashboard lists terminals by CPU; arrows choose and enter goes there", async () => {
  const { draw, view, c } = await mount({ overlay: "o9" }, { width: 860, height: 640 });
  const tree = draw();
  assert.ok(byId(tree, "term-t7") && byId(tree, "term-t4"));
  const order = ids(tree).filter((i) => i.startsWith("term-"));
  assert.deepEqual(order.slice(0, 2), ["term-t7", "term-t4"]);
  const root = byId(tree, "root");
  root.handlers.on_key_down({ key: "down" }, c);
  assert.equal(view.sel, 1);
  root.handlers.on_key_down({ key: "enter" }, c);
  assert.deepEqual(world.runs.at(-1), ["pane.focus", { terminal: "t4" }]);
  assert.deepEqual(world.closed, ["o9"], "going there closes the dashboard");
});

test("the dashboard asks the sampler for the process list", async () => {
  const { c, view } = await mount({ overlay: "o1" }, { width: 860, height: 640 });
  const { createFeed } = await import("../mods/herdr-stats/feed.js");
  view.feed = createFeed(view.deps()); // the shared one already asked, in an earlier test
  world.execs = [];
  c.timers[0].fn(c);
  await c.settle();
  assert.ok(world.execs.some(([cmd, args]) => cmd === "touch" && args[0].endsWith("/want-detail")));
});

test("the menu shows where the stats are, and a click puts them there", async () => {
  const { draw } = await mount({ view: "menu" });
  let tree = draw();
  assert.ok(byId(tree, "spot-left"));
  byId(tree, "spot-status").handlers.on_click(null, cx());
  const [name, args] = world.runs.at(-1);
  assert.equal(name, "layout.set");
  assert.ok(JSON.stringify(args.layout).includes('"stats-status"'));
  tree = draw();
  const checked = (id) => [...nodes(byId(tree, id))].some((n) => n.arg === "mods/herdr-stats/check.svg");
  assert.equal(checked("spot-status"), true);
  assert.equal(checked("spot-left"), false);
  byId(tree, "spot-status").handlers.on_click(null, cx());
  assert.ok(!JSON.stringify(world.layout).includes("stats-status"), "a second click takes it out");
});

test("on one of Herdr's own layouts the menu copies it first, and says so", async () => {
  const { draw, view } = await mount({ view: "menu" });
  world.layoutName = "main";
  view.shipped = new Set(["main"]);
  const tree = draw();
  assert.match(text(tree), /makes a copy \(main-stats\)/);
  byId(tree, "spot-left").handlers.on_click(null, cx());
  assert.deepEqual(world.runs.map((r) => r[0]), ["layout.clone", "layout.set"]);
  assert.deepEqual(world.runs[0][1], { name: "main", as: "main-stats" });
});

test("readings are chosen once for every copy, in a fixed order", async () => {
  const { draw } = await mount({ view: "menu" });
  byId(draw(), "metric-gpu").handlers.on_click(null, cx());
  assert.deepEqual(world.shared["herdr-stats.metrics"], ["cpu", "mem", "net", "temp", "top"]);
  byId(draw(), "metric-disk").handlers.on_click(null, cx());
  assert.deepEqual(world.shared["herdr-stats.metrics"], ["cpu", "mem", "net", "disk", "temp", "top"]);
});

test("toggling a reading resizes a sidebar panel to fit", async () => {
  const { draw } = await mount({ view: "menu" });
  world.layout.children[0].children.splice(2, 0, { id: "stats-left", type: "block", size: { px: 216 }, content: { mod: "herdr-stats", props: { spot: "left" } } });
  byId(draw(), "metric-disk").handlers.on_click(null, cx());
  const resize = world.runs.find((r) => r[0] === "layout.resize");
  assert.equal(resize[1].id, "stats-left");
  assert.ok(resize[1].px > 216);
});

test("panel height is the header and every line it would show", () => {
  const r = readings(JSON.parse(SNAP_TEXT));
  const h6 = views.panelHeight({ r, metrics: ["cpu", "mem", "gpu", "net", "temp", "top"], top: {} });
  const h1 = views.panelHeight({ r, metrics: ["cpu"], top: {} });
  assert.equal(h1, 41 + 10 + 25 + 14);
  assert.equal(h6, h1 + 5 * 25);
});

test("while the sampler starts, and when it can't, the panel says so", async () => {
  reset({ spot: "left" });
  world.files = {};
  world.exec = () => Promise.reject(new Error("No such file or directory (os error 2)"));
  const view = new Stats();
  const c = cx();
  view.init({ spot: "left" }, c);
  view.size = { width: 268, height: 216 };
  // A feed shared by every copy outlives this test's mount: give this one a feed of its own.
  const { createFeed } = await import("../mods/herdr-stats/feed.js");
  view.feed = createFeed({ ...view.deps(), now: () => Date.now() });
  assert.match(text(view.render(c)), /Reading the machine/);
  view.feed.ensure((body) => c.spawn(body));
  await c.settle();
  const tree = view.render(c);
  assert.match(text(tree), /The sampler didn't start/);
  assert.match(byId(tree, "problem").tip, /No such file/);
});

test("in the background a sidebar redraws at most every 5 s; the dashboard keeps up", async () => {
  const { c, view } = await mount({ spot: "left" });
  const before = c.notified;
  world.window = { platform: "macos", active: false };
  view.seen = "something-else";
  view.drawnAt = Date.now();
  world.files[SNAP_PATH] = SNAP_TEXT.replace(/"t": \d+/, `"t": ${Date.now() + 1}`);
  view.feed.read = async () => JSON.parse(world.files[SNAP_PATH]);
  view.tick(c);
  await c.settle();
  assert.equal(c.notified, before, "skipped: drawn less than 5 s ago");
  view.drawnAt = Date.now() - 6000;
  view.tick(c);
  await c.settle();
  assert.equal(c.notified, before + 1);
});

test("the drawer puts its figures on the edge side, where they peek", async () => {
  const { view, c } = await mount({ spot: "float" });
  const row = (edge) => {
    world.placement = { edge, align: "end", vertical: true, hovered: false, dragging: false };
    const kids = byId(view.render(c), "drawer-cpu").kids;
    return kids.map((k) => (/%/.test(text(k)) && text(k).length < 12 ? "figure" : "chart"));
  };
  try {
    assert.deepEqual(row("right"), ["chart", "figure"]);
    assert.deepEqual(row("left"), ["figure", "chart"]);
  } finally {
    world.placement = null;
  }
});

test("the sensor line is the icon and each reading, in order, as many as fit", async () => {
  const { draw, view } = await mount({ spot: "left" }, { width: 268, height: 260 });
  const row = byId(draw(), "row-temp");
  const shown = (tree) => ids(tree).filter((i) => i.startsWith("sensor-"));
  assert.deepEqual(shown(row), ["sensor-cpu", "sensor-soc", "sensor-ssd", "sensor-battery"]);
  assert.match(text(row), /^CPU 41° SoC 38° SSD 34° Bat 29°$/);
  assert.doesNotMatch(text(row), /Sensors/, "no label: the icon says it");
  assert.match(row.tip, /Battery 29° · fastest fan 2\.4k rpm/, "the tooltip still has everything");
  view.size = { width: 400, height: 260 };
  assert.deepEqual(shown(byId(draw(), "row-temp")).at(-1), "sensor-fan", "wider: the fan joins");
  view.size = { width: 150, height: 260 };
  assert.deepEqual(shown(byId(draw(), "row-temp")), ["sensor-cpu", "sensor-soc"]);
});

test("in a narrow column the terminal table keeps only CPU, so names have room", async () => {
  const { terminalSection } = views;
  const ui = { t: new Proxy({}, { get: () => "#808080" }), mono: "m", r: readings(JSON.parse(SNAP_TEXT)), sel: 0, act: {} };
  ui.rows = [{ address: "t7", name: "cargo", where: "shop › build", title: "", cpu: 2.1, rss: 1e8, procs: 3, program: null }];
  const narrow = text(terminalSection(ui, 280));
  assert.match(narrow, /CPU/);
  assert.doesNotMatch(narrow, /Memory|Procs/);
  assert.match(text(terminalSection(ui, 420)), /Memory.*Procs/);
});
