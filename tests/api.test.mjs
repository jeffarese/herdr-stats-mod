// Every builder method the views call exists in the gpui-kit Herdr ships. The stub
// builder accepts any name, so without this a typo would only show up in the app.
// Herdr writes gpui-kit.d.ts into ~/.config/herdr-app (and into each mod folder);
// where neither exists (CI), the test is skipped.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { world } from "herdr";
import { methods, nodes } from "gpui-kit";
import * as views from "../mods/herdr-stats/views.js";
import { readings, terminalRows, busiest } from "../mods/herdr-stats/model.js";

const candidates = [
  new URL("../mods/herdr-stats/gpui-kit.d.ts", import.meta.url).pathname,
  `${process.env.HERDR_APP_HOME ?? `${homedir()}/.config/herdr-app`}/gpui-kit.d.ts`,
];
const dts = candidates.find((p) => existsSync(p));

test("the views only call methods gpui-kit has", { skip: !dts && "no gpui-kit.d.ts here" }, () => {
  const source = readFileSync(dts, "utf8");
  const known = new Set([...source.matchAll(/^\s+([a-z_][a-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/gm)].map((m) => m[1]));
  const snap = JSON.parse(readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8"));
  const r = readings(snap);
  // Every optional part filled in, so every branch of every view is drawn.
  const rows = terminalRows(r.terms, { panes: [], agents: [], spaces: [], terminals: [] }).map((x) => ({ ...x, where: "api › tests", title: "Retry", process: "cargo", focused: true }));
  const base = {
    t: new Proxy({}, { get: () => "#808080" }),
    mono: "JetBrains Mono",
    r,
    rows,
    top: busiest(rows),
    metrics: ["cpu", "mem", "gpu", "net", "disk", "temp", "top"],
    dashKey: "⌘⌥S",
    sel: 0,
    handle: {},
    act: new Proxy({}, { get: () => () => {} }),
    problem: { text: "x", detail: "y" },
  };
  const trees = [
    views.panel({ ...base, width: 268, height: 400 }),
    views.panel({ ...base, r: null, width: 268, height: 400 }),
    views.rail({ ...base, width: 60, height: 400 }),
    views.strip({ ...base, width: 900, height: 28, spot: "status" }),
    views.drawer({ ...base, placement: { edge: "right", vertical: true } }),
    views.drawer({ ...base, placement: { edge: "left", vertical: true } }),
    views.dashboard({ ...base, width: 860, height: 640, overlay: "o1" }),
    views.dashboard({ ...base, width: 500, height: 640 }),
    views.column({ ...base, width: 300, height: 800 }),
    views.menu({ ...base, spots: { left: { on: true, enabled: true }, right: { on: false, enabled: false, why: "no" }, status: { on: false, enabled: true }, tabs: { on: false, enabled: true }, float: { on: false, enabled: true } }, note: "n" }),
  ];
  const used = new Set();
  for (const tree of trees) for (const m of methods(tree)) used.add(m);
  const unknown = [...used].filter((m) => !known.has(m)).sort();
  assert.deepEqual(unknown, [], `not in ${dts}`);

  // A method whose every declaration needs an argument, called with none
  // (flex_shrink() for flex_shrink_1()): GPUI fails the whole render on it.
  const needs = new Map();
  for (const [, name, params] of source.matchAll(/^\s+([a-z_][a-z0-9_]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/gm)) {
    const required = params
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p && !p.startsWith("this") && !p.startsWith("...") && !/^\w+\?/.test(p));
    needs.set(name, (needs.get(name) ?? true) && required.length > 0);
  }
  const bare = new Set();
  for (const tree of trees) for (const n of nodes(tree)) for (const [name, ...args] of n.calls ?? []) if (args.length === 0 && needs.get(name)) bare.add(name);
  assert.deepEqual([...bare].sort(), [], "called without the argument gpui-kit requires");
  assert.ok(world, "stub world loaded");
});
