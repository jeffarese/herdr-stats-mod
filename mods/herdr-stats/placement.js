// Where the stats show: pure edits of a layout tree (layouts/<name>.json), so the
// "Show in" menu can put the mod in a sidebar, a bar or a drawer without anyone
// writing JSON. Every edit returns a new tree; the input is never changed.

export const MOD = "herdr-stats";

export const SPOTS = [
  { id: "left", label: "Left sidebar", about: "Under the lists in the sidebar", icon: "panel-left" },
  { id: "right", label: "Right sidebar", about: "A column on the right edge", icon: "panel-right" },
  { id: "status", label: "Status bar", about: "One line at the bottom", icon: "status" },
  { id: "tabs", label: "Tab bar", about: "At the end of the tabs", icon: "tabs" },
  { id: "float", label: "Floating drawer", about: "Peeks from the right edge", icon: "float" },
];

// Ids of the blocks this mod adds, and of the rows it wraps around a bar to make
// room (taken apart again when the block goes). `stats-wrap-right` is what older
// versions wrapped a right-edge panel in; it is still taken apart.
const BLOCK_ID = { left: "stats-left", right: "stats-right", status: "stats-status", tabs: "stats-tabs", float: "stats-float" };
const WRAP_ID = { right: "stats-wrap-right", status: "stats-wrap-status", tabs: "stats-wrap-tabs" };

// Sidebars belong to the layout, not to a mod: the right one is a column every
// panel there shares (the stats, the pull requests, a board), so folding it
// folds them together. It stays while any panel is in it.
const RIGHT_SIDEBAR = "sidebar-right";

// Sizes as designed at zoom 1. The panel fits its rows to whatever height it gets.
// left: the panel's height with the six default readings (views.panelHeight), so none is cut.
export const SIZES = { left: 216, right: 300, status: 380, tabs: 340, tall: 268 };

const clone = (v) => JSON.parse(JSON.stringify(v));
const modOf = (n) => (n?.content && typeof n.content === "object" ? n.content.mod : undefined);
const ours = (n) => modOf(n) === MOD && n.content?.props?.view === undefined;
const spotOf = (n) => n?.content?.props?.spot ?? Object.keys(BLOCK_ID).find((k) => BLOCK_ID[k] === n?.id) ?? null;
const holdsTabs = (n) => Boolean(n?.content?.tab) || (n?.children ?? []).some(holdsTabs);

function* walk(node, parent = null) {
  if (!node || typeof node !== "object") return;
  yield { node, parent };
  for (const child of node.children ?? []) yield* walk(child, node);
}

export function findNode(root, test) {
  for (const hit of walk(root)) if (test(hit.node)) return hit;
  return null;
}

/** Where this mod shows in a layout now: a set of spot ids. */
export function spotsIn(root) {
  const out = new Set();
  for (const { node } of walk(root)) if (ours(node)) out.add(spotOf(node) ?? "left");
  for (const f of root?.floating ?? []) if (ours(f)) out.add("float");
  return out;
}

const block = (spot, size) => ({
  id: BLOCK_ID[spot],
  type: "block",
  ...(size ? { size } : {}),
  content: { mod: MOD, props: { spot } },
});

/** The sidebar column on one side, or null. `side` is "left" or "right". */
function sidebar(root, side) {
  if (side === "left") {
    const named = findNode(root, (n) => n.id === "sidebar" && n.type === "column");
    if (named) return named.node;
  }
  if (root?.type !== "row" || !root.children?.length) return null;
  const edge = side === "left" ? root.children[0] : root.children[root.children.length - 1];
  return edge && edge.type === "column" && !holdsTabs(edge) ? edge : null;
}

/** Whether a spot can be offered for this layout (and how). */
export function available(root, spot) {
  if (!root || typeof root !== "object") return false;
  switch (spot) {
    case "left":
      return Boolean(sidebar(root, "left")) || root.type === "row";
    case "right":
      return root.type === "row";
    case "status":
    case "tabs":
      return Boolean(findNode(root, (n) => n.type === "block" && n.content?.tab));
    case "float":
      return true;
    default:
      return false;
  }
}

function insertLeft(root) {
  const col = sidebar(root, "left");
  if (col) {
    // Above a footer (Herdr's sidebar keeps Settings at the very bottom).
    const footer = col.children.findIndex((c) => c.id === "sidebar-footer" || c.content?.props?.footer);
    const at = footer >= 0 ? footer : col.children.length;
    col.children.splice(at, 0, block("left", { px: SIZES.left }));
    return root;
  }
  root.children.unshift({ id: BLOCK_ID.left, type: "block", size: { px: SIZES.tall }, content: { mod: MOD, props: { spot: "left" } } });
  return root;
}

function insertRight(root) {
  const last = root.children[root.children.length - 1];
  if (last && last.type === "column" && !holdsTabs(last)) {
    last.children.push(block("right", { px: SIZES.right }));
    return root;
  }
  if (last && last.type === "block" && !last.content?.tab && last.id !== BLOCK_ID.left) {
    // A panel alone on the right edge (a PR list, a board): it and the stats share a
    // right sidebar, at the panel's width.
    const { size, min, max, ...rest } = last;
    root.children[root.children.length - 1] = {
      id: RIGHT_SIDEBAR,
      type: "column",
      ...(size ? { size } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      divider: { width: 1, color: "border" },
      children: [{ ...rest, size: { weight: 1 } }, block("right", { px: SIZES.right })],
    };
    return root;
  }
  // Nothing on the right yet: a right sidebar with the stats in it, for other panels to join.
  root.children.push({
    id: RIGHT_SIDEBAR,
    type: "column",
    size: { px: SIZES.tall },
    min: 44,
    max: 520,
    divider: { width: 1, color: "border" },
    children: [block("right", { weight: 1 })],
  });
  return root;
}

// Beside a bar block (the status line, the tab bar): wrap it in a row and add ours at its end.
function insertBeside(root, spot, test) {
  const hit = findNode(root, test);
  if (!hit || !hit.parent) return null;
  const { node, parent } = hit;
  const index = parent.children.indexOf(node);
  const { size, min, max, hidden, ...rest } = node;
  parent.children[index] = {
    id: WRAP_ID[spot],
    type: "row",
    ...(size ? { size } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(hidden ? { hidden } : {}),
    resizable: false,
    children: [{ ...rest, size: { weight: 1 } }, block(spot, { px: SIZES[spot] })],
  };
  return root;
}

function insertStatus(root) {
  const bar = (n) => n.type === "block" && (modOf(n) === "workspace-status" || (n.id === "status" && !ours(n)));
  if (insertBeside(root, "status", bar)) return root;
  // No status bar: a line of its own under the column that holds the tabs.
  const tab = findNode(root, (n) => n.type === "block" && n.content?.tab);
  let host = null;
  for (const { node } of walk(root)) if (node.type === "column" && holdsTabs(node)) host = node;
  if (!host || !tab) return null;
  host.children.push(block("status", { px: 28 }));
  return root;
}

function insertTabs(root) {
  const bar = (n) => n.type === "block" && (modOf(n) === "tabs" || (n.id === "tabs" && !ours(n)));
  if (insertBeside(root, "tabs", bar)) return root;
  return null;
}

function insertFloat(root) {
  root.floating = [
    ...(root.floating ?? []),
    { id: BLOCK_ID.float, content: { mod: MOD, props: { spot: "float" } }, edge: "right", align: "end", peek: 58 },
  ];
  return root;
}

/** The layout with the stats added at `spot` (already there: unchanged). Null when it can't go there. */
export function addSpot(layout, spot) {
  if (!layout || typeof layout !== "object") return null;
  if (spotsIn(layout).has(spot)) return layout;
  const root = clone(layout);
  switch (spot) {
    case "left":
      return root.type === "row" || sidebar(root, "left") ? insertLeft(root) : null;
    case "right":
      return root.type === "row" ? insertRight(root) : null;
    case "status":
      return insertStatus(root);
    case "tabs":
      return insertTabs(root);
    case "float":
      return insertFloat(root);
    default:
      return null;
  }
}

/** The layout without the stats at `spot`, with any row or column made for it taken apart. */
export function removeSpot(layout, spot) {
  if (!layout || typeof layout !== "object") return null;
  const root = clone(layout);
  if (spot === "float") {
    root.floating = (root.floating ?? []).filter((f) => !(ours(f) && (spotOf(f) ?? "float") === "float"));
    if (!root.floating.length) delete root.floating;
    return root;
  }
  const doomed = [];
  for (const { node, parent } of walk(root)) if (parent && ours(node) && (spotOf(node) ?? "left") === spot) doomed.push({ node, parent });
  for (const { node, parent } of doomed) {
    parent.children.splice(parent.children.indexOf(node), 1);
    unwrap(root, parent);
    dropEmptySidebar(root, parent);
  }
  return root;
}

// The right sidebar goes with its last panel; with other panels in it, it stays theirs.
function dropEmptySidebar(root, column) {
  if (column.id !== RIGHT_SIDEBAR || column.children.length) return;
  const hit = findNode(root, (n) => (n.children ?? []).includes(column));
  if (hit) hit.node.children.splice(hit.node.children.indexOf(column), 1);
}

// A wrapper this mod made, now down to the one thing it wrapped: put that thing back as it was.
function unwrap(root, wrapper) {
  if (!Object.values(WRAP_ID).includes(wrapper.id) || wrapper.children.length !== 1) return;
  const hit = findNode(root, (n) => (n.children ?? []).includes(wrapper));
  if (!hit) return;
  const [only] = wrapper.children;
  const restored = { ...only };
  delete restored.size;
  if (wrapper.size) restored.size = wrapper.size;
  if (wrapper.min !== undefined) restored.min = wrapper.min;
  if (wrapper.max !== undefined) restored.max = wrapper.max;
  if (wrapper.hidden) restored.hidden = wrapper.hidden;
  const siblings = hit.node.children;
  siblings[siblings.indexOf(wrapper)] = restored;
}

/** Adds or removes, whichever it isn't. */
export function toggleSpot(layout, spot) {
  return spotsIn(layout).has(spot) ? removeSpot(layout, spot) : addSpot(layout, spot);
}

/** The id of the block at `spot`, for layout.resize. */
export const blockId = (spot) => BLOCK_ID[spot];

/** A free name for a personal copy of one of Herdr's layouts. */
export function copyName(name, taken) {
  const have = new Set(taken ?? []);
  let candidate = `${name}-stats`;
  for (let i = 2; have.has(candidate); i++) candidate = `${name}-stats-${i}`;
  return candidate;
}
