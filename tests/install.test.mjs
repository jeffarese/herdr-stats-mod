// scripts/install.py against a throwaway app home: keys, layouts and the sampler.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { addSpot, removeSpot, SPOTS } from "../mods/herdr-stats/placement.js";

const SCRIPT = new URL("../scripts/install.py", import.meta.url).pathname;
const MAIN = JSON.parse(readFileSync(new URL("./fixtures/layout-main.json", import.meta.url), "utf8"));
const PRS = JSON.parse(readFileSync(new URL("./fixtures/layout-prs.json", import.meta.url), "utf8"));

function appHome() {
  const home = mkdtempSync(join(tmpdir(), "herdr-stats-"));
  mkdirSync(join(home, "layouts"));
  writeFileSync(join(home, "installed.json"), JSON.stringify({ "layout:main": {}, agents: {} }));
  return home;
}
const py = (home, ...args) => execFileSync("python3", [SCRIPT, ...args], { env: { ...process.env, HERDR_APP_HOME: home }, encoding: "utf8" });
const json = (p) => JSON.parse(readFileSync(p, "utf8"));

test("keys: binds ⌥⌘S once, leaves a taken key alone, and takes back only its own", () => {
  const home = appHome();
  try {
    const keys = join(home, "keys.json");
    writeFileSync(keys, JSON.stringify({ global: { "cmd-k": "app.palette" }, terminal: {} }));
    py(home, "keys", "add");
    py(home, "keys", "add");
    assert.deepEqual(json(keys).global, { "cmd-k": "app.palette", "cmd-alt-s": "mod.open:herdr-stats" });
    py(home, "keys", "remove");
    assert.deepEqual(json(keys).global, { "cmd-k": "app.palette" });
    writeFileSync(keys, JSON.stringify({ global: { "cmd-alt-s": "tab.new" } }));
    assert.match(py(home, "keys", "add"), /already yours/);
    py(home, "keys", "remove");
    assert.deepEqual(json(keys).global, { "cmd-alt-s": "tab.new" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("keys: no keys.json means no file is created (it would drop Herdr's defaults)", () => {
  const home = appHome();
  try {
    py(home, "keys", "add");
    assert.equal(existsSync(join(home, "keys.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("layouts: --remove takes the stats out of every personal layout, exactly as JS put them in", () => {
  const home = appHome();
  try {
    for (const [name, base] of [["mine", MAIN], ["prs", PRS]]) {
      let l = base;
      for (const s of SPOTS) l = addSpot(l, s.id);
      writeFileSync(join(home, "layouts", `${name}.json`), JSON.stringify(l));
    }
    // Herdr's own layout is never touched, even if something put the mod there.
    const herdrs = addSpot(MAIN, "left");
    writeFileSync(join(home, "layouts", "main.json"), JSON.stringify(herdrs));
    py(home, "layouts", "remove");
    assert.deepEqual(json(join(home, "layouts", "mine.json")), MAIN);
    // The pull requests keep the right sidebar they came to share with the stats.
    assert.deepEqual(json(join(home, "layouts", "prs.json")), removeSpot(addSpot(PRS, "right"), "right"));
    assert.equal(json(join(home, "layouts", "prs.json")).children.at(-1).id, "sidebar-right");
    assert.deepEqual(json(join(home, "layouts", "main.json")), herdrs);
    assert.ok(existsSync(join(home, "layouts", "mine.json.before-stats")), "the old file is kept");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sampler stop: a lock naming some other program is never signalled", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "herdr-stats-home-"));
  const sleeper = spawn("sleep", ["30"]);
  try {
    const cache = process.platform === "darwin" ? join(fakeHome, "Library/Caches/herdr-stats") : join(fakeHome, ".cache/herdr-stats");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "sampler.lock"), `${sleeper.pid}\n`);
    execFileSync("python3", [SCRIPT, "sampler", "stop"], { env: { ...process.env, HOME: fakeHome } });
    assert.equal(sleeper.exitCode, null);
    assert.equal(sleeper.signalCode, null, "sleep is still running");
  } finally {
    sleeper.kill();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
