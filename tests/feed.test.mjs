import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFeed, SAMPLER_LIFETIME, SAMPLER_IDLE } from "../mods/herdr-stats/feed.js";

const SNAP = JSON.parse(readFileSync(new URL("./fixtures/snapshot.json", import.meta.url), "utf8"));

function harness({ platform = "macos", bin = "/app/mods/herdr-stats/bin/herdr-stats-sampler", file = null } = {}) {
  const h = {
    clock: SNAP.t,
    file,
    reads: 0,
    execs: [],
    pending: [],
    spawned: [],
  };
  h.feed = createFeed({
    platform,
    bin,
    dir: "/home/me/Library/Caches/herdr-stats",
    interval: 1000,
    now: () => h.clock,
    readTextFile: async (path) => {
      h.reads++;
      if (path.endsWith("snapshot.json")) return h.file;
      return h.procFiles?.[path] ?? null;
    },
    exec: (cmd, args, opts) => {
      h.execs.push({ cmd, args, opts });
      if (cmd === h.feedBin) return new Promise((resolve) => h.pending.push(resolve));
      return Promise.resolve(h.execResult ?? { code: 0, stdout: "", stderr: "" });
    },
  });
  h.feedBin = bin;
  h.spawn = (body) => h.spawned.push(body());
  return h;
}

test("reads the snapshot, and copies asking in the same tick share one read", async () => {
  const h = harness({ file: JSON.stringify(SNAP) });
  const [a, b, c] = await Promise.all([h.feed.read(), h.feed.read(), h.feed.read()]);
  assert.equal(a.seq, 42);
  assert.equal(b, a);
  assert.equal(c, a);
  assert.equal(h.reads, 1);
  h.clock += 300;
  await h.feed.read();
  assert.equal(h.reads, 1, "a second copy's timer a moment later reuses it");
  h.clock += 1000;
  await h.feed.read();
  assert.equal(h.reads, 2);
});

test("a torn or older file never replaces what is shown", async () => {
  const h = harness({ file: JSON.stringify(SNAP) });
  await h.feed.read();
  h.file = JSON.stringify(SNAP).slice(0, 100);
  h.clock += 1000;
  assert.equal((await h.feed.read()).seq, 42);
  h.file = JSON.stringify({ ...SNAP, t: SNAP.t - 5000, seq: 1 });
  h.clock += 1000;
  assert.equal((await h.feed.read()).seq, 42);
});

test("starts one sampler when the snapshot is stale, never while one runs", async () => {
  const h = harness();
  await h.feed.read();
  assert.equal(h.feed.ensure(h.spawn), true);
  assert.equal(h.execs.length, 1);
  const { cmd, args, opts } = h.execs[0];
  assert.equal(cmd, "/app/mods/herdr-stats/bin/herdr-stats-sampler");
  assert.deepEqual(args, ["--dir", "/home/me/Library/Caches/herdr-stats", "--interval", "1000", "--lifetime", String(SAMPLER_LIFETIME), "--idle", String(SAMPLER_IDLE)]);
  assert.ok(opts.timeout > SAMPLER_LIFETIME && opts.timeout <= 600_000, "the exec outlives the sampler's own lifetime, within Herdr's cap");
  h.clock += 3_000;
  assert.equal(h.feed.ensure(h.spawn), false, "still starting");
  h.file = JSON.stringify({ ...SNAP, t: h.clock });
  h.clock += 1_000;
  await h.feed.read();
  h.clock += 1_000;
  assert.equal(h.feed.ensure(h.spawn), false, "running: it writes the file");
  assert.equal(h.execs.length, 1);
});

test("a start whose copy closed (its task dropped, never settled) doesn't block the next", async () => {
  const h = harness();
  h.feed.ensure(h.spawn);
  assert.equal(h.feed.running, true);
  h.clock += 5_000;
  assert.equal(h.feed.ensure(h.spawn), true, "stale 5 s after the last start: start again");
  assert.equal(h.execs.length, 2);
});

test("a fresh snapshot (another copy's sampler) means nothing to start", async () => {
  const h = harness({ file: JSON.stringify(SNAP) });
  await h.feed.read();
  assert.equal(h.feed.ensure(h.spawn), false);
  assert.equal(h.execs.length, 0);
});

test("when the sampler retires on schedule the next one starts at once", async () => {
  const h = harness();
  h.feed.ensure(h.spawn);
  h.pending[0]({ code: 0, stdout: "", stderr: "" });
  await Promise.all(h.spawned);
  assert.equal(h.feed.running, false);
  assert.equal(h.feed.ensure(h.spawn), true);
  assert.equal(h.execs.length, 2);
});

test("a sampler that fails is reported, and retried no faster than every 5 s", async () => {
  const h = harness();
  h.feedBin = "never-pending";
  h.execResult = { code: 1, stdout: "", stderr: "herdr-stats-sampler: cannot lock\n" };
  h.feed.ensure(h.spawn);
  await Promise.all(h.spawned);
  assert.equal(h.feed.error, "herdr-stats-sampler: cannot lock");
  assert.equal(h.feed.ensure(h.spawn), true, "a finished exec frees the next start");
});

test("a sampler that can't start at all (missing binary) is reported", async () => {
  const h = harness();
  h.feedBin = "x";
  const feed = createFeed({
    platform: "macos",
    bin: "/nope",
    dir: "/d",
    now: () => h.clock,
    readTextFile: async () => null,
    exec: () => Promise.reject(new Error("No such file or directory")),
  });
  const done = [];
  feed.ensure((body) => done.push(body()));
  await Promise.all(done);
  assert.match(feed.error, /No such file/);
});

test("copies check in with the sampler once per 10 s between them, never by signal", async () => {
  const h = harness({ file: JSON.stringify(SNAP) });
  await Promise.all([h.feed.checkIn(), h.feed.checkIn(), h.feed.checkIn()]);
  assert.deepEqual(h.execs.map((e) => [e.cmd, ...e.args]), [["touch", "/home/me/Library/Caches/herdr-stats/alive"]]);
  h.clock += 9_000;
  await h.feed.checkIn();
  assert.equal(h.execs.length, 1);
  h.clock += 1_000;
  await h.feed.checkIn();
  assert.equal(h.execs.length, 2);
  assert.ok(SAMPLER_IDLE >= 3 * 10_000, "a missed touch or two never ends a sampler someone is looking at");
  assert.ok(!h.execs.some((e) => e.cmd === "kill"));
});

test("the dashboard asks for process detail by touching a file, at most every 5 s", async () => {
  const h = harness({ file: JSON.stringify(SNAP) });
  await h.feed.wantDetail();
  await h.feed.wantDetail();
  assert.deepEqual(h.execs.map((e) => [e.cmd, ...e.args]), [["touch", "/home/me/Library/Caches/herdr-stats/want-detail"]]);
  h.clock += 5000;
  await h.feed.wantDetail();
  assert.equal(h.execs.length, 2);
});

test("Linux without the binary reads /proc itself and never execs a sampler", async () => {
  const h = harness({ platform: "linux", bin: null });
  h.procFiles = {
    "/proc/stat": "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0\n",
    "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 400 kB\n",
    "/proc/net/dev": "a\nb\n eth0: 10 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0\n",
  };
  h.execResult = { code: 0, stdout: "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 100 40 60 40% /\n", stderr: "" };
  const s = await h.feed.read();
  assert.equal(h.feed.source, "proc");
  assert.equal(s.mem.used, 600 * 1024);
  assert.deepEqual(s.disk, { total: 102400, used: 40960, available: 61440 });
  assert.equal(h.feed.ensure(h.spawn), false);
  assert.deepEqual(h.execs.map((e) => e.cmd), ["df"]);
});

test("Windows: no source, and nothing is started", async () => {
  const h = harness({ platform: "windows", bin: null });
  assert.equal(h.feed.source, "none");
  assert.equal(h.feed.ensure(h.spawn), false);
  assert.equal(await h.feed.read(), null);
});
