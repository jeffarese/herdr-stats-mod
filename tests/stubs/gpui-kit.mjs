// An element is a record of every builder call made on it; tests read the tree back.
// Unknown builder methods are accepted and recorded, so a misspelt one shows up in
// `calls` rather than failing; the method names are checked against gpui-kit.d.ts
// by tests/api.test.mjs instead.

const HANDLERS = new Set(["on_click", "on_size_change", "on_key_down", "on_mouse_down", "on_hover", "on_scroll_wheel"]);

export function make(kind, arg) {
  const node = { kind, arg, calls: [], kids: [], handlers: {}, idValue: undefined, tip: undefined };
  const el = new Proxy(node, {
    get(target, key) {
      if (typeof key === "symbol" || key === "then") return undefined;
      if (key in target) return target[key];
      if (key === "child") return (c) => (c !== null && c !== undefined && target.kids.push(c), el);
      if (key === "children") return (list) => (target.kids.push(...(list ?? []).filter((c) => c !== null && c !== undefined)), el);
      if (key === "when") return (cond, fn) => (cond ? fn(el) : el);
      if (key === "id") return (v) => ((target.idValue = v), target.calls.push(["id", v]), el);
      if (key === "tooltip") return (v) => ((target.tip = v), target.calls.push(["tooltip", v]), el);
      if (key === "hover") return (fn) => (target.calls.push(["hover", fn]), el);
      if (HANDLERS.has(key)) return (...args) => ((target.handlers[key] = args[args.length - 1]), target.calls.push([key, ...args]), el);
      return (...args) => (target.calls.push([key, ...args]), el);
    },
  });
  return el;
}

export class View {}
export const div = () => make("div");
export const svg = (path) => make("svg", path);
export const image = (path) => make("image", path);

// Tree helpers for tests.
export function* nodes(el) {
  if (!el || typeof el !== "object") return;
  yield el;
  for (const k of el.kids ?? []) yield* nodes(k);
}
export const byId = (root, id) => [...nodes(root)].find((n) => n.idValue === id) ?? null;
export function text(el) {
  if (typeof el === "string") return el;
  if (!el || typeof el !== "object") return "";
  return (el.kids ?? []).map(text).filter(Boolean).join(" ");
}
export const ids = (root) => [...nodes(root)].map((n) => n.idValue).filter(Boolean);
export const methods = (root) => new Set([...nodes(root)].flatMap((n) => (n.calls ?? []).map((c) => c[0])));
