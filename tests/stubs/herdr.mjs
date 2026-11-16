// The herdr module, backed by a world the test sets up. Calls that act are recorded.
export const world = {
  props: {},
  placement: null,
  window: { platform: "macos", active: true },
  layout: null,
  layoutName: "mine",
  layouts: ["main", "mine"],
  shared: {},
  settings: { zoom: 1, font_family: "JetBrains Mono" },
  panes: [],
  agents: [],
  spaces: [],
  terminals: [],
  keys: [{ section: "global", keys: "cmd-alt-s", action: "mod.open:herdr-stats" }],
  files: {},
  runs: [],
  overlays: [],
  closed: [],
  execs: [],
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};

export const theme = () =>
  new Proxy({}, { get: (_t, k) => (typeof k === "string" ? `#${[...k].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(6, "0").slice(0, 6)}` : undefined) });
export const settings = () => world.settings;
export const props = () => world.props;
export const placement = () => world.placement;
export const window = () => world.window;
export const layout = () => world.layout;
export const layouts = () => world.layouts;
export const shared = (k) => (k === "layout" ? world.layoutName : world.shared[k]);
export const setShared = (k, v) => {
  world.shared[k] = v;
  return null;
};
export const run = (name, args) => {
  world.runs.push([name, args]);
  if (name === "layout.set") world.layout = args.layout;
  if (name === "layout.clone") {
    world.layout = { ...world.layout, cloned_from: { name: args.name } };
    world.layoutName = args.as;
    world.layouts = [...world.layouts, args.as];
  }
  return null;
};
export const openOverlay = (spec) => {
  world.overlays.push(spec);
  return `o${world.overlays.length}`;
};
export const closeOverlay = (id) => {
  world.closed.push(id);
  return null;
};
export const panes = () => world.panes;
export const agents = () => world.agents;
export const spaces = () => world.spaces;
export const terminals = () => world.terminals;
export const keys = () => world.keys;
export const appHome = () => "/home/me/.config/herdr-app";
export const home = () => "/home/me";
export const readTextFile = async (p) => world.files[p] ?? null;
export const exec = (...args) => {
  world.execs.push(args);
  return world.exec(...args);
};
