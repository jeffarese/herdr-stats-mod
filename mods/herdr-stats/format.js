// Numbers for people: short enough for a sidebar, steady enough not to jitter.

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

// 45.5 GB, 512 MB, 1.1 TB: one decimal under 100, none above, so the width stays put.
export function bytes(n, { compact = false } = {}) {
  if (!Number.isFinite(n) || n < 0) return "–";
  let i = 0;
  let v = n;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const text = i === 0 ? String(Math.round(v)) : v < 10 ? v.toFixed(1) : v < 100 ? v.toFixed(1) : String(Math.round(v));
  if (compact) return `${text}${i === 0 ? "B" : UNITS[i][0]}`;
  return `${text} ${UNITS[i]}`;
}

// Throughput: 22 KB/s, 1.4 MB/s; compact 22K, 1.4M. Under a kilobyte is quiet: 0 KB/s.
export function rate(n, { compact = false } = {}) {
  if (!Number.isFinite(n) || n < 0) return "–";
  if (n < 1024) return compact ? "0K" : "0 KB/s";
  const b = bytes(n, { compact });
  return compact ? b : `${b}/s`;
}

// A fraction as a whole percent, clamped: 0.374 → "37%".
export function pct(x) {
  if (!Number.isFinite(x)) return "–";
  return `${Math.round(Math.min(Math.max(x, 0), 1) * 100)}%`;
}

// CPU of one process tree, the way top and Activity Monitor count it: 2.14 → "214%".
export function cores(x) {
  if (!Number.isFinite(x) || x < 0) return "–";
  const p = x * 100;
  return p >= 10 || p === 0 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`;
}

export function degrees(c) {
  return Number.isFinite(c) ? `${Math.round(c)}°` : "–";
}

export function uptime(secs) {
  if (!Number.isFinite(secs) || secs < 0) return "–";
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function rpm(r) {
  if (!Number.isFinite(r)) return "–";
  if (r < 1) return "off";
  return r >= 1000 ? `${(r / 1000).toFixed(1)}k rpm` : `${Math.round(r)} rpm`;
}

// "⌥⌘S" on macOS, "Ctrl+Alt+S" elsewhere, from a keys.json chord.
export function chord(keys, mac) {
  if (!keys) return "";
  const parts = keys.endsWith("--") ? [...keys.slice(0, -2).split("-"), "-"] : keys.split("-");
  const sym = mac
    ? { cmd: "⌘", ctrl: "⌃", shift: "⇧", alt: "⌥", option: "⌥" }
    : { cmd: "Ctrl+", ctrl: "Ctrl+", shift: "Shift+", alt: "Alt+", option: "Alt+" };
  return parts.map((p) => sym[p.toLowerCase()] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join("");
}
