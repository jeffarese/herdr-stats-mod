import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as place from "../mods/herdr-stats/placement.js";

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const main = () => load("layout-main");
const prs = () => load("layout-prs");
const find = (root, id) => place.findNode(root, (n) => n.id === id);
const ourBlocks = (root) => {
  const out = [];
  const walk = (n) => {
    if (n?.content?.mod === place.MOD) out.push(n);
    (n?.children ?? []).forEach(walk);
  };
  walk(root);
  return out;
};

test("left: under the lists, above the sidebar's footer", () => {
  const out = place.addSpot(main(), "left");
  const sidebar = find(out, "sidebar").node;
  const ids = sidebar.children.map((c) => c.id);
  assert.deepEqual(ids, ["brand", "sidebar-lists", "stats-left", "sidebar-footer"]);
  assert.deepEqual(find(out, "stats-left").node.content, { mod: "herdr-stats", props: { spot: "left" } });
  assert.ok(place.spotsIn(out).has("left"));
});

test("every spot comes out exactly as it went in", () => {
  for (const fixture of [main, prs]) {
    for (const spot of place.SPOTS.map((s) => s.id)) {
      // A panel alone at the right edge keeps the sidebar it now shares (see below).
      if (fixture === prs && spot === "right") continue;
      const before = fixture();
      const added = place.addSpot(before, spot);
      assert.ok(added, `${spot} can be added`);
      assert.notDeepEqual(added, before, `${spot} changed the layout`);
      assert.ok(place.spotsIn(added).has(spot), `${spot} is found again`);
      assert.deepEqual(place.removeSpot(added, spot), before, `${spot} removed restores the layout`);
    }
  }
});

test("right: a panel alone on the right edge and the stats share a right sidebar", () => {
  const out = place.addSpot(prs(), "right");
  const last = out.children.at(-1);
  assert.equal(last.id, "sidebar-right", "the sidebar is the layout's, not named after either mod");
  assert.equal(last.type, "column");
  assert.deepEqual(last.size, { px: 340 }, "the column keeps the panel's width");
  assert.equal(last.min, 44);
  assert.deepEqual(last.children.map((c) => c.id), ["prs", "stats-right"]);
  assert.deepEqual(last.children[0].size, { weight: 1 });
  assert.equal(last.children[0].min, undefined, "the panel's width limits moved to the sidebar");
  const back = place.removeSpot(out, "right");
  assert.deepEqual(back.children.at(-1).children.map((c) => c.id), ["prs"], "the sidebar stays the panel's");
  assert.deepEqual(back.children.at(-1).size, { px: 340 });
});

test("right: with nothing on the right, the stats start a right sidebar others can join", () => {
  const out = place.addSpot(main(), "right");
  const last = out.children.at(-1);
  assert.equal(last.id, "sidebar-right");
  assert.equal(last.type, "column");
  assert.deepEqual(last.children.map((c) => c.id), ["stats-right"]);
  assert.deepEqual(last.children[0].size, { weight: 1 }, "alone, the stats fill it");
  assert.equal(out.children.length, main().children.length + 1);
  assert.deepEqual(place.removeSpot(out, "right"), main(), "the sidebar goes with its last panel");
});

test("right: a right sidebar that holds other panels gets the stats at its foot", () => {
  const out = place.addSpot(place.addSpot(prs(), "right"), "left");
  const again = place.addSpot(place.removeSpot(out, "right"), "right");
  assert.deepEqual(again.children.at(-1).children.map((c) => c.id), ["prs", "stats-right"]);
  assert.equal(again.children.at(-1).id, "sidebar-right", "joined, not wrapped twice");
});

test("right: the wrapper older versions made is still taken apart", () => {
  const old = place.addSpot(prs(), "right");
  old.children.at(-1).id = "stats-wrap-right";
  assert.deepEqual(place.removeSpot(old, "right"), prs());
});

test("status and tabs: the bar and the stats share a row, the bar keeps its height", () => {
  const out = place.addSpot(main(), "status");
  const wrap = find(out, "stats-wrap-status").node;
  assert.equal(wrap.type, "row");
  assert.deepEqual(wrap.size, main().children[1].children.find((c) => c.id === "status").size);
  assert.equal(wrap.resizable, false);
  assert.deepEqual(wrap.children.map((c) => c.id), ["status", "stats-status"]);
  const tabs = place.addSpot(main(), "tabs");
  const tw = find(tabs, "stats-wrap-tabs").node;
  assert.deepEqual(tw.children.map((c) => c.id), ["tabs", "stats-tabs"]);
  assert.equal(tw.children[0].window_drag, true, "the tab bar still drags the window");
});

test("status: a layout without a status bar gets a line under the tabs' column", () => {
  const bare = main();
  const work = bare.children[1];
  work.children = work.children.filter((c) => c.id !== "status");
  const out = place.addSpot(bare, "status");
  assert.equal(out.children[1].children.at(-1).id, "stats-status");
  assert.deepEqual(out.children[1].children.at(-1).size, { px: 28 });
});

test("float: a drawer on the right edge that peeks", () => {
  const out = place.addSpot(main(), "float");
  assert.deepEqual(out.floating, [{ id: "stats-float", content: { mod: "herdr-stats", props: { spot: "float" } }, edge: "right", align: "end", peek: 58 }]);
  const keepsOthers = place.removeSpot({ ...out, floating: [...out.floating, { id: "board", content: { mod: "board" } }] }, "float");
  assert.deepEqual(keepsOthers.floating, [{ id: "board", content: { mod: "board" } }]);
});

test("several spots at once, each removable on its own", () => {
  let l = main();
  for (const s of ["left", "status", "float"]) l = place.addSpot(l, s);
  assert.deepEqual([...place.spotsIn(l)].sort(), ["float", "left", "status"]);
  assert.equal(ourBlocks(l).length, 2);
  l = place.removeSpot(l, "status");
  assert.deepEqual([...place.spotsIn(l)].sort(), ["float", "left"]);
  assert.ok(find(l, "status"), "the status bar is back in place");
  assert.equal(find(l, "stats-wrap-status"), null);
});

test("adding twice changes nothing; toggling flips", () => {
  const once = place.addSpot(main(), "left");
  assert.equal(place.addSpot(once, "left"), once);
  assert.deepEqual(place.toggleSpot(once, "left"), main());
  assert.ok(place.spotsIn(place.toggleSpot(main(), "tabs")).has("tabs"));
});

test("the input tree is never changed", () => {
  const before = main();
  const frozen = JSON.stringify(before);
  for (const s of place.SPOTS) place.addSpot(before, s.id);
  assert.equal(JSON.stringify(before), frozen);
});

test("spots that can't go anywhere are refused, not forced", () => {
  const column = { id: "root", type: "column", children: [{ id: "x", type: "block", content: { mod: "files" } }] };
  assert.equal(place.available(column, "right"), false);
  assert.equal(place.available(column, "status"), false, "no tab block to sit beside");
  assert.equal(place.addSpot(column, "right"), null);
  assert.equal(place.available(column, "float"), true);
  assert.equal(place.addSpot(null, "left"), null);
});

test("a block the person placed by hand (no spot prop) still counts, as left", () => {
  const l = main();
  l.children[0].children.push({ id: "mine", type: "block", content: { mod: "herdr-stats" } });
  assert.ok(place.spotsIn(l).has("left"));
  const off = place.removeSpot(l, "left");
  assert.equal(find(off, "mine"), null);
});

test("an overlay of the mod named in a layout is not mistaken for a placement", () => {
  const l = main();
  l.children[0].children.push({ id: "menu", type: "block", content: { mod: "herdr-stats", props: { view: "menu" } } });
  assert.equal(place.spotsIn(l).size, 0);
});

test("a copy of Herdr's layout gets a free name", () => {
  assert.equal(place.copyName("main", ["main"]), "main-stats");
  assert.equal(place.copyName("main", ["main", "main-stats", "main-stats-2"]), "main-stats-3");
});
