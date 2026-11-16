// What the snapshot means: readings, severities, chart data and who is using the machine.
// Pure: no host calls, so tests run it under node.

// The readings a person can choose to show, in the order they read best.
export const METRICS = [
  { id: "cpu", label: "CPU", about: "Load, its trend and every core" },
  { id: "mem", label: "Memory", about: "Used, wired and compressed" },
  { id: "gpu", label: "GPU", about: "How busy the GPU is" },
  { id: "net", label: "Network", about: "Download and upload" },
  { id: "disk", label: "Disk", about: "Used and free on the startup disk" },
  { id: "temp", label: "Sensors", about: "Temperatures and fans" },
  { id: "top", label: "Busiest terminal", about: "Which agent or shell uses the most" },
];
export const DEFAULT_METRICS = ["cpu", "mem", "gpu", "net", "temp", "top"];

// When a reading turns amber, then red. Temperatures in °C.
export const THRESHOLDS = {
  cpu: [0.7, 0.9],
  mem: [0.8, 0.92],
  pressure: [0.5, 0.75],
  gpu: [0.75, 0.92],
  disk: [0.85, 0.95],
  temp: [85, 97],
  fan: [0.75, 0.9],
};

export function level(kind, value) {
  const t = THRESHOLDS[kind];
  if (!t || !Number.isFinite(value)) return "ok";
  return value >= t[1] ? "crit" : value >= t[0] ? "warn" : "ok";
}

const WORST = { ok: 0, warn: 1, crit: 2 };
export const worst = (...levels) => levels.reduce((a, b) => (WORST[b] > WORST[a] ? b : a), "ok");

/** The snapshot file's text, or null when it is missing, torn or from another version. */
export function parse(text) {
  if (!text) return null;
  try {
    const s = JSON.parse(text);
    if (!s || s.v !== 1 || !Number.isFinite(s.t) || !s.cpu) return null;
    return s;
  } catch {
    return null;
  }
}

/** Old enough that the sampler must have stopped (asleep, killed, never started). */
export function isStale(snap, now, interval = 1000) {
  return !snap || now - snap.t > Math.max(3500, interval * 3.5);
}

const num = (x) => (Number.isFinite(x) ? x : null);

/** Everything a view draws, in one shape, whatever the machine could measure. */
export function readings(snap) {
  if (!snap) return null;
  const c = snap.cpu ?? {};
  const cores = Array.isArray(c.cores) ? c.cores : [];
  const m = snap.mem;
  const memory = m && m.total > 0
    ? {
        total: m.total,
        used: m.used,
        fraction: m.used / m.total,
        wired: m.wired ?? 0,
        compressed: m.compressed ?? 0,
        app: Math.max(0, (m.used ?? 0) - (m.wired ?? 0) - (m.compressed ?? 0)),
        swap: m.swap ?? 0,
        pressure: num(m.pressure),
      }
    : null;
  if (memory) memory.level = worst(level("mem", memory.fraction), level("pressure", memory.pressure));
  const d = snap.disk;
  // Full is whatever isn't available: on APFS the container's other volumes and snapshots
  // count, as in Finder (a sampler before 0.1.1 sent the data volume's own blocks as `used`).
  const disk = d && d.total > 0 ? { total: d.total, used: d.total - d.available, available: d.available, fraction: 1 - d.available / d.total } : null;
  if (disk) disk.level = level("disk", disk.fraction);
  const t = snap.temp ?? {};
  const fans = Array.isArray(snap.fans) ? snap.fans : [];
  const fastest = fans.reduce((a, f) => (!a || f.rpm > a.rpm ? f : a), null);
  const hottest = [t.cpu, t.gpu, t.soc].filter(Number.isFinite);
  const headline = hottest.length ? Math.max(...hottest) : null;
  const sensors = [
    ["CPU", t.cpu],
    ["GPU", t.gpu],
    ["SoC", t.soc],
    ["SSD", t.ssd],
    ["Battery", t.battery],
  ].filter(([, v]) => Number.isFinite(v)).map(([name, value]) => ({ name, value, level: level("temp", value) }));
  const hist = snap.hist ?? {};
  return {
    host: snap.host ?? null,
    os: snap.os ?? null,
    uptime: num(snap.uptime),
    load: Array.isArray(snap.load) ? snap.load : null,
    cpu: {
      value: num(c.total) ?? 0,
      max: num(c.max) ?? 0,
      p: num(c.p),
      e: num(c.e),
      pcores: Number.isInteger(c.pcores) ? c.pcores : null,
      cores,
      hist: Array.isArray(hist.cpu) ? hist.cpu : [],
      level: level("cpu", c.total),
    },
    mem: memory && { ...memory, hist: Array.isArray(hist.mem) ? hist.mem : [] },
    gpu: snap.gpu ? { value: snap.gpu.busy ?? 0, memory: num(snap.gpu.memory), hist: Array.isArray(hist.gpu) ? hist.gpu : [], level: level("gpu", snap.gpu.busy) } : null,
    disk,
    net: snap.net ? { rx: snap.net.rx ?? 0, tx: snap.net.tx ?? 0, rxHist: hist.rx ?? [], txHist: hist.tx ?? [] } : null,
    temp: headline === null && !sensors.length ? null : { headline, avg: num(t.cpu_avg), sensors, level: level("temp", headline) },
    fan: fastest ? { rpm: fastest.rpm, fraction: fastest.fraction ?? 0, count: fans.length, level: level("fan", fastest.fraction) } : null,
    terms: Array.isArray(snap.terms) ? snap.terms : null,
    top: Array.isArray(snap.top) ? snap.top : null,
  };
}

/** The newest `n` samples (a chart narrower than the history keeps the present). */
export function recent(series, n) {
  if (!Array.isArray(series) || n <= 0) return [];
  return series.length <= n ? series.slice() : series.slice(series.length - n);
}

/**
 * Cores pooled into at most `n` cells, keeping each group's busiest core: the
 * one pinned core is what a per-core row exists to show, and an average would
 * hide it. `split` is the index of the first efficiency cell, when known.
 */
export function poolCores(cores, n, pcores = null) {
  const list = Array.isArray(cores) ? cores : [];
  if (n <= 0 || !list.length) return { cells: [], split: null };
  const hasSplit = Number.isInteger(pcores) && pcores > 0 && pcores < list.length;
  if (list.length <= n) return { cells: list.slice(), split: hasSplit ? pcores : null };
  const pool = (part, k) => {
    const out = [];
    for (let i = 0; i < k; i++) {
      const from = Math.floor((i * part.length) / k);
      const to = Math.max(from + 1, Math.floor(((i + 1) * part.length) / k));
      out.push(Math.max(...part.slice(from, to)));
    }
    return out;
  };
  if (!hasSplit) return { cells: pool(list, n), split: null };
  const p = list.slice(0, pcores);
  const e = list.slice(pcores);
  const kp = Math.max(1, Math.min(p.length, Math.round((n * p.length) / list.length)));
  const ke = Math.max(1, Math.min(e.length, n - kp));
  return { cells: [...pool(p, kp), ...pool(e, ke)], split: kp };
}

// A title without its status glyph (✳, ⠋…), as Herdr's own lists show it.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();

/**
 * The sampler's per-terminal usage, named the way Herdr names things.
 * `world`: { panes, agents, spaces, terminals } from the herdr module.
 * Each row: what it is, where it is, and how to get there.
 */
export function terminalRows(terms, world) {
  if (!Array.isArray(terms)) return [];
  const panes = new Map((world.panes ?? []).filter((p) => p.terminal).map((p) => [p.terminal, p]));
  const agents = new Map((world.agents ?? []).map((a) => [a.address, a]));
  const terminals = new Map((world.terminals ?? []).map((t) => [t.address, t]));
  const tabs = new Map();
  for (const s of world.spaces ?? []) for (const t of s.tabs ?? []) tabs.set(t.id, { space: s, tab: t });
  return terms
    .map((u) => {
      const pane = panes.get(u.a);
      const agent = agents.get(u.a);
      const term = terminals.get(u.a);
      const program = agent?.program ?? pane?.program ?? term?.program ?? null;
      const place = pane ? tabs.get(pane.tab) : agent ? tabs.get(agent.tab) : null;
      const where = place ? `${place.space.name} › ${place.tab.name}` : term?.parent ? "sub-agent" : "";
      const title = clean(agent?.title ?? pane?.title ?? term?.title ?? term?.name ?? "");
      return {
        address: u.a,
        cpu: Number.isFinite(u.cpu) ? u.cpu : 0,
        rss: Number.isFinite(u.rss) ? u.rss : 0,
        procs: u.n ?? 0,
        process: u.top ?? null,
        name: program?.name ?? u.top ?? u.a,
        program,
        title: title && title !== program?.name ? title : "",
        where,
        status: agent?.status ?? pane?.status ?? null,
        pane: pane?.pane ?? null,
        focused: Boolean(pane?.focused),
      };
    })
    .sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);
}

/** The terminal worth naming in a sidebar: the busiest, if it is doing anything. */
export function busiest(rows) {
  const top = rows[0];
  if (!top) return null;
  return top.cpu >= 0.02 ? top : rows.reduce((a, r) => (r.rss > a.rss ? r : a), top);
}

// ---------------------------------------------------------------------------
// Linux without the sampler binary: the same snapshot from /proc, read by the
// mod itself. No temperatures or GPU; everything else.

export function parseProcStat(text) {
  const out = [];
  for (const line of (text ?? "").split("\n")) {
    const m = /^cpu(\d*)\s+(.*)$/.exec(line);
    if (!m) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    const idle = (f[3] ?? 0) + (f[4] ?? 0);
    const total = f.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
    out.push({ core: m[1] === "" ? -1 : Number(m[1]), idle, total });
  }
  return out;
}

export function cpuFromTicks(before, now) {
  const busy = (b, n) => {
    const total = n.total - b.total;
    return total > 0 ? Math.min(1, Math.max(0, 1 - (n.idle - b.idle) / total)) : 0;
  };
  const prev = new Map((before ?? []).map((c) => [c.core, c]));
  let total = 0;
  const cores = [];
  for (const c of now) {
    const b = prev.get(c.core);
    if (!b) continue;
    if (c.core < 0) total = busy(b, c);
    else cores[c.core] = busy(b, c);
  }
  return { total, cores: cores.map((v) => v ?? 0) };
}

export function parseMeminfo(text) {
  const kb = {};
  for (const line of (text ?? "").split("\n")) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) kb[m[1]] = Number(m[2]) * 1024;
  }
  if (!kb.MemTotal) return null;
  const available = kb.MemAvailable ?? kb.MemFree ?? 0;
  return {
    total: kb.MemTotal,
    used: Math.max(0, kb.MemTotal - available),
    wired: 0,
    compressed: 0,
    swap: Math.max(0, (kb.SwapTotal ?? 0) - (kb.SwapFree ?? 0)),
    pressure: null,
  };
}

const VIRTUAL = /^(lo|docker|br-|veth|virbr|tun|tailscale|wg)/;
export function parseNetDev(text) {
  let rx = 0;
  let tx = 0;
  for (const line of (text ?? "").split("\n").slice(2)) {
    const [name, rest] = line.split(":");
    if (!rest || VIRTUAL.test(name.trim())) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0] || 0;
    tx += f[8] || 0;
  }
  return { rx, tx };
}

// `df -kP /`: the second line's 1K-blocks, used, available.
export function parseDf(text) {
  const line = (text ?? "").trim().split("\n")[1];
  if (!line) return null;
  const f = line.trim().split(/\s+/);
  const [total, used, available] = [f[1], f[2], f[3]].map((v) => Number(v) * 1024);
  return Number.isFinite(total) && total > 0 ? { total, used, available } : null;
}

const HISTORY = 180;
const push = (list, v) => {
  const out = Array.isArray(list) ? list.slice(-(HISTORY - 1)) : [];
  out.push(v);
  return out;
};

/** The next snapshot from /proc readings and the previous state (which carries the counters). */
export function linuxSnapshot(prev, raw, now) {
  const ticks = parseProcStat(raw.stat);
  const net = parseNetDev(raw.netdev);
  const mem = parseMeminfo(raw.meminfo);
  const cpu = prev?.ticks ? cpuFromTicks(prev.ticks, ticks) : { total: 0, cores: [] };
  const secs = prev?.at ? Math.max(0.001, (now - prev.at) / 1000) : 0;
  const rate = (a, b) => (secs && b >= a ? (b - a) / secs : 0);
  const rx = prev?.net ? rate(prev.net.rx, net.rx) : 0;
  const tx = prev?.net ? rate(prev.net.tx, net.tx) : 0;
  const load = (raw.loadavg ?? "").trim().split(/\s+/).slice(0, 3).map(Number);
  const hist = prev?.snap?.hist ?? {};
  const snap = {
    v: 1,
    t: now,
    seq: (prev?.snap?.seq ?? 0) + 1,
    interval: 1000,
    os: "linux",
    host: raw.hostname?.trim() || null,
    uptime: Number((raw.uptime ?? "").split(/\s+/)[0]) || null,
    load: load.length === 3 && load.every(Number.isFinite) ? load : null,
    cpu: { total: cpu.total, max: cpu.cores.length ? Math.max(...cpu.cores) : cpu.total, p: null, e: null, pcores: null, cores: cpu.cores },
    mem,
    disk: raw.df ? parseDf(raw.df) : prev?.snap?.disk ?? null,
    gpu: null,
    net: { rx, tx },
    temp: {},
    fans: [],
    hist: {
      cpu: push(hist.cpu, cpu.total),
      mem: mem ? push(hist.mem, mem.used / mem.total) : hist.mem ?? [],
      gpu: [],
      rx: push(hist.rx, rx),
      tx: push(hist.tx, tx),
    },
    terms: null,
    top: null,
  };
  return { snap, ticks, net, at: now };
}
