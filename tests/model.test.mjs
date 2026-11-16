import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as model from "../mods/herdr-stats/model.js";
import * as format from "../mods/herdr-stats/format.js";

const SNAP_TEXT = readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8");
const snap = () => JSON.parse(SNAP_TEXT);

test("a snapshot parses; a torn, foreign or empty file doesn't", () => {
  assert.equal(model.parse(SNAP_TEXT).seq, 42);
  assert.equal(model.parse(SNAP_TEXT.slice(0, 200)), null);
  assert.equal(model.parse(JSON.stringify({ ...snap(), v: 2 })), null);
  assert.equal(model.parse(""), null);
  assert.equal(model.parse(null), null);
});

test("a snapshot goes stale after three and a half intervals, or 3.5 s", () => {
  const s = snap();
  assert.equal(model.isStale(s, s.t + 3000), false);
  assert.equal(model.isStale(s, s.t + 3600), true);
  assert.equal(model.isStale(s, s.t + 9000, 3000), false);
  assert.equal(model.isStale(null, 0), true);
});

test("severity turns amber, then red, at each reading's own thresholds", () => {
  assert.equal(model.level("cpu", 0.5), "ok");
  assert.equal(model.level("cpu", 0.7), "warn");
  assert.equal(model.level("cpu", 0.95), "crit");
  assert.equal(model.level("temp", 86), "warn");
  assert.equal(model.level("temp", null), "ok");
  assert.equal(model.worst("ok", "crit", "warn"), "crit");
});

test("readings split memory into app, wired and compressed, and rate it by pressure too", () => {
  const r = model.readings(snap());
  assert.equal(r.mem.app, 45486407680 - 5752307712 - 9889464320);
  assert.ok(Math.abs(r.mem.fraction - 0.662) < 0.001);
  assert.equal(r.mem.level, "ok");
  const tight = model.readings({ ...snap(), mem: { ...snap().mem, pressure: 0.8 } });
  assert.equal(tight.mem.level, "crit");
});

test("readings name the hottest compute sensor and the fastest fan; missing sensors drop out", () => {
  const r = model.readings(snap());
  assert.equal(r.temp.headline, 40.5);
  assert.deepEqual(r.temp.sensors.map((s) => s.name), ["CPU", "SoC", "SSD", "Battery"]);
  assert.equal(r.fan.rpm, 2400);
  assert.equal(r.fan.count, 2);
  const bare = model.readings({ ...snap(), temp: {}, fans: [], gpu: null, disk: null });
  assert.equal(bare.temp, null);
  assert.equal(bare.fan, null);
  assert.equal(bare.gpu, null);
  assert.equal(bare.disk, null);
});

test("disk use is whatever isn't available, as Finder counts it (the M2 Max: 75%, not 58%)", () => {
  // An old sampler sent the data volume's own blocks as `used`; the reading ignores that.
  const r = model.readings({ ...snap(), disk: { total: 494384795648, used: 286583906304, available: 123675836416 } });
  assert.ok(Math.abs(r.disk.fraction - 0.75) < 0.005, String(r.disk.fraction));
  assert.equal(r.disk.used, 494384795648 - 123675836416);
  assert.equal(model.readings({ ...snap(), disk: { total: 0, used: 0, available: 0 } }).disk, null);
});

test("a chart narrower than the history keeps the newest samples", () => {
  assert.deepEqual(model.recent([1, 2, 3, 4, 5], 3), [3, 4, 5]);
  assert.deepEqual(model.recent([1, 2], 5), [1, 2]);
  assert.deepEqual(model.recent(null, 5), []);
});

test("pooled cores keep each group's busiest core and the cluster boundary", () => {
  const cores = [0.92, 0.5, 0.4, 0.3, 0.2, 0.1, ...Array(12).fill(0.05)];
  const all = model.poolCores(cores, 40, 6);
  assert.equal(all.cells.length, 18);
  assert.equal(all.split, 6);
  const pooled = model.poolCores(cores, 6, 6);
  assert.equal(pooled.cells.length, 6);
  assert.equal(pooled.cells[0], 0.92, "the pinned core survives pooling");
  assert.ok(pooled.split >= 1 && pooled.split < 6);
  assert.deepEqual(model.poolCores([0.1, 0.9, 0.2, 0.3], 2).cells, [0.9, 0.3]);
  assert.deepEqual(model.poolCores([], 4), { cells: [], split: null });
});

function world() {
  const claude = { key: "claude", name: "Claude Code", agent: true, icon: "icons/claude.svg", tint: true };
  const zsh = { key: "shell", name: "zsh", shell: true };
  return {
    spaces: [{ id: "s1", name: "api", tabs: [{ id: "tb1", name: "tests" }, { id: "tb2", name: "2" }] }],
    panes: [
      { pane: "p1", terminal: "t4", tab: "tb1", title: "✳ Retry the flaky auth test", program: claude, focused: true },
      { pane: "p2", terminal: "t9", tab: "tb2", title: "~/api", program: zsh, focused: false },
    ],
    agents: [{ address: "t4", pane: "p1", tab: "tb1", title: "✳ Retry the flaky auth test", status: "working", program: claude }],
    terminals: [{ address: "t7", parent: "t4", name: "build", program: { name: "cargo" } }],
  };
}

test("terminal rows are named and placed the way Herdr names them, busiest first", () => {
  const rows = model.terminalRows(snap().terms, world());
  assert.deepEqual(rows.map((r) => r.address), ["t7", "t4", "t9"]);
  const agent = rows.find((r) => r.address === "t4");
  assert.equal(agent.name, "Claude Code");
  assert.equal(agent.where, "api › tests");
  assert.equal(agent.title, "Retry the flaky auth test", "status glyph stripped");
  assert.equal(agent.pane, "p1");
  assert.equal(agent.status, "working");
  const sub = rows.find((r) => r.address === "t7");
  assert.equal(sub.where, "sub-agent");
  assert.equal(sub.pane, null, "no pane: the dashboard peeks at it instead");
  assert.deepEqual(model.terminalRows(null, world()), []);
});

test("the busiest terminal is the top CPU one, or the biggest when everything is idle", () => {
  const rows = model.terminalRows(snap().terms, world());
  assert.equal(model.busiest(rows).address, "t7");
  const idle = model.terminalRows(snap().terms.map((t) => ({ ...t, cpu: 0 })), world());
  assert.equal(model.busiest(idle).address, "t4");
  assert.equal(model.busiest([]), null);
});

test("Linux: /proc readings make the same snapshot shape, with rates from the second read on", () => {
  const stat1 = "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0\n";
  const stat2 = "cpu  150 0 150 900 0 0 0 0 0 0\ncpu0 100 0 100 400 0 0 0 0\ncpu1 50 0 50 500 0 0 0 0\n";
  const meminfo = "MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    6000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n";
  const netdev = (rx, tx) => `h1\nh2\n    lo: 999 1 0 0 0 0 0 0 999 0 0 0 0 0 0 0\n  eth0: ${rx} 1 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0\n`;
  const df = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 400 600 40% /\n";
  const raw = (stat, rx, tx) => ({ stat, meminfo, netdev: netdev(rx, tx), loadavg: "0.50 0.40 0.30 1/200 999", uptime: "3600.5 7000", hostname: "box\n", df });
  const a = model.linuxSnapshot(null, raw(stat1, 1000, 500), 10_000);
  assert.equal(a.snap.cpu.total, 0);
  assert.equal(a.snap.net.rx, 0);
  const b = model.linuxSnapshot(a, raw(stat2, 3048, 1524), 11_000);
  assert.equal(b.snap.cpu.total, 0.5);
  assert.deepEqual(b.snap.cpu.cores, [1, 0]);
  assert.equal(b.snap.net.rx, 2048);
  assert.equal(b.snap.net.tx, 1024);
  assert.equal(b.snap.mem.used, 10000000 * 1024);
  assert.equal(b.snap.mem.swap, 500000 * 1024);
  assert.deepEqual(b.snap.disk, { total: 1000 * 1024, used: 400 * 1024, available: 600 * 1024 });
  assert.equal(b.snap.host, "box");
  assert.equal(b.snap.uptime, 3600.5);
  assert.deepEqual(b.snap.load, [0.5, 0.4, 0.3]);
  assert.equal(b.snap.hist.cpu.length, 2);
  assert.ok(model.parse(JSON.stringify(b.snap)), "a /proc snapshot is a valid snapshot");
  assert.ok(model.readings(b.snap).mem);
});

test("numbers stay short and steady", () => {
  assert.equal(format.bytes(45486407680), "42.4 GB");
  assert.equal(format.bytes(45486407680, { compact: true }), "42.4G");
  assert.equal(format.bytes(512), "512 B");
  assert.equal(format.bytes(1995165736960), "1.8 TB");
  assert.equal(format.bytes(-1), "–");
  assert.equal(format.rate(500), "0 KB/s");
  assert.equal(format.rate(22078), "21.6 KB/s");
  assert.equal(format.rate(22078, { compact: true }), "21.6K");
  assert.equal(format.pct(0.374), "37%");
  assert.equal(format.pct(1.4), "100%");
  assert.equal(format.cores(2.14), "214%");
  assert.equal(format.cores(0.042), "4.2%");
  assert.equal(format.degrees(40.5), "41°");
  assert.equal(format.uptime(1146804), "13d 6h");
  assert.equal(format.uptime(3700), "1h 1m");
  assert.equal(format.rpm(0), "off");
  assert.equal(format.rpm(2400), "2.4k rpm");
  assert.equal(format.chord("cmd-alt-s", true), "⌘⌥S");
  assert.equal(format.chord("cmd-alt-s", false), "Ctrl+Alt+S");
});
