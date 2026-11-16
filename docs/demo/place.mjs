// Prints a layout with the stats added to or taken out of the given places, using the mod's
// own placement code (what Show in… does).
//
//   node place.mjs <layout.json> add left status
//   node place.mjs <layout.json> remove left
import { readFileSync } from "node:fs";
import { addSpot, removeSpot } from "../../mods/herdr-stats/placement.js";

const [file, op, ...spots] = process.argv.slice(2);
if (!file || !["add", "remove"].includes(op)) {
  console.error("usage: node place.mjs <layout.json> add|remove <place>...");
  process.exit(2);
}
let tree = JSON.parse(readFileSync(file, "utf8"));
for (const spot of spots) tree = (op === "add" ? addSpot : removeSpot)(tree, spot) ?? tree;
process.stdout.write(JSON.stringify(tree));
