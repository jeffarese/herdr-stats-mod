// The snapshot every copy of the mod shows, and the sampler that writes it.
//
// One sampler serves every copy (a sidebar panel, a status line, an open
// dashboard): it takes a lock, so a second start exits at once. Copies share
// one feed per source version, so the file is read once per tick however many
// copies are showing. Host functions are passed in, which is what lets the
// tests run this under node.

import { parse, isStale, linuxSnapshot } from "./model.js";

export const SAMPLER_LIFETIME = 540_000; // under the 600 s Herdr allows an exec
const RELAUNCH_AFTER = 5_000;
const DETAIL_EVERY = 5_000;
// Copies check in this often; the sampler exits 30 s (`--idle`) after the last one.
export const CHECK_IN_EVERY = 10_000;
export const SAMPLER_IDLE = 30_000;

/**
 * deps: { exec, readTextFile, now, bin, dir, platform, interval }
 * `bin` null: no sampler binary for this machine (then Linux reads /proc itself).
 */
export function createFeed(deps) {
  const interval = deps.interval ?? 1000;
  const file = `${deps.dir}/snapshot.json`;
  const state = {
    snap: null,
    readAt: 0,
    reading: null,
    launchedAt: 0,
    launches: 0,
    running: false,
    error: null,
    detailAt: 0,
    aliveAt: 0,
    linux: null, // counters carried between /proc reads
    dfAt: 0,
  };

  async function readFile() {
    const text = await deps.readTextFile(file).catch(() => null);
    const snap = parse(text);
    // Only ever forwards: a torn or older file keeps what was shown.
    if (snap && (!state.snap || snap.t >= state.snap.t)) state.snap = snap;
  }

  async function readProc() {
    const now = deps.now();
    const read = (p) => deps.readTextFile(p).catch(() => null);
    const [stat, meminfo, netdev, loadavg, uptime, hostname] = await Promise.all(
      ["/proc/stat", "/proc/meminfo", "/proc/net/dev", "/proc/loadavg", "/proc/uptime", "/proc/sys/kernel/hostname"].map(read),
    );
    if (!stat) return;
    let df = null;
    if (now - state.dfAt > 30_000) {
      state.dfAt = now;
      df = await deps.exec("df", ["-kP", "/"], { timeout: 5000 }).then((r) => r.stdout, () => null);
    }
    state.linux = linuxSnapshot(state.linux, { stat, meminfo, netdev, loadavg, uptime, hostname, df }, now);
    state.snap = state.linux.snap;
  }

  const useProc = () => !deps.bin && deps.platform === "linux";

  /** The latest snapshot; reads at most about once per interval, whoever asks. */
  async function read() {
    if (state.reading) return state.reading;
    if (state.snap && deps.now() - state.readAt < interval * 0.6) return state.snap;
    state.readAt = deps.now();
    state.reading = (useProc() ? readProc() : readFile())
      .then(() => state.snap)
      .finally(() => {
        state.reading = null;
      });
    return state.reading;
  }

  function stale() {
    return isStale(state.snap, deps.now(), interval);
  }

  /**
   * Starts a sampler when the snapshot has gone quiet. `spawn` runs the async
   * body on the calling copy's context (cx.spawn). When that copy closes, its
   * task can be dropped without `finally` ever running, so `running` is not
   * trusted: a stale file 5 s after the last start means start again. The
   * sampler's lock turns a needless start into an instant exit.
   */
  function ensure(spawn) {
    if (useProc() || !deps.bin) return false;
    if (!stale()) return false;
    if (deps.now() - state.launchedAt < RELAUNCH_AFTER) return false;
    state.launchedAt = deps.now();
    state.launches += 1;
    state.running = true;
    spawn(async () => {
      try {
        const r = await deps.exec(deps.bin, ["--dir", deps.dir, "--interval", String(interval), "--lifetime", String(SAMPLER_LIFETIME), "--idle", String(SAMPLER_IDLE)], {
          timeout: SAMPLER_LIFETIME + 45_000,
        });
        state.error = r.code === 0 ? null : (r.stderr || `exit ${r.code}`).trim();
      } catch (e) {
        state.error = String(e?.message ?? e);
      } finally {
        state.running = false;
        // Allow the next start right away: a sampler that retired on schedule
        // should be followed by the next without a gap in the charts.
        state.launchedAt = 0;
      }
    });
    return true;
  }

  /**
   * The dashboard asks for the per-process list while it is open: the sampler
   * lists processes only while `want-detail` is fresh. `touch` rather than a
   * file write, because a mod writes only under Herdr's own folder, which Herdr
   * watches; a file changing there every few seconds would wake it for nothing.
   */
  async function wantDetail() {
    if (!deps.bin || deps.now() - state.detailAt < DETAIL_EVERY) return;
    state.detailAt = deps.now();
    await deps.exec("touch", [`${deps.dir}/want-detail`], { timeout: 5000 }).catch(() => null);
  }

  /**
   * Tells the sampler someone is still showing the stats. Every copy calls it
   * each tick; one `touch` per 10 s goes out however many copies there are. When
   * the last copy closes the sampler notices within 30 s and exits: close()
   * can't wait for a kill (Herdr cancels it after 250 ms), and a layout switch
   * closes every copy just before opening the new ones.
   */
  async function checkIn() {
    if (!deps.bin || deps.now() - state.aliveAt < CHECK_IN_EVERY) return;
    state.aliveAt = deps.now();
    await deps.exec("touch", [`${deps.dir}/alive`], { timeout: 5000 }).catch(() => null);
  }

  return {
    read,
    ensure,
    stale,
    wantDetail,
    checkIn,
    get snap() {
      return state.snap;
    },
    get error() {
      return state.error;
    },
    get launches() {
      return state.launches;
    },
    get running() {
      return state.running;
    },
    get source() {
      return useProc() ? "proc" : deps.bin ? "sampler" : "none";
    },
  };
}

// One feed per source version, shared by every copy (created on first use, in init).
let shared = null;
export function sharedFeed(make) {
  shared ??= createFeed(make());
  return shared;
}
