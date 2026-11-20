#!/bin/sh
# The README's scenes on a showcase stage (~/workspace/herdr/herdr-showcase): the kit's stage.sh
# runs this as its hook, with no scene, after its default scene; showcase-shots.sh runs it again
# with a scene before each picture.
#
#   showcase.sh <stage>            the main scene (preview.png): the stats tall in the right
#                                  sidebar, and a line of them at the end of the status bar
#   showcase.sh <stage> dashboard  the main scene with the dashboard open (⌥⌘S)
#   showcase.sh <stage> menu       the main scene with the Show in… menu in a floating block
#   showcase.sh <stage> places     the other places: the left sidebar, the tab bar, the status
#                                  bar and a drawer on the right edge (the right sidebar's
#                                  panel taken out)
#
# Every place is added or taken out with the mod's own placement code (place.mjs), as Show in…
# does; this script only sets the sizes and the drawer's edge, and shows the tab bar, which the
# stage's layout keeps hidden.
set -eu
w=$(cd "${1:?usage: showcase.sh <stage> [main|dashboard|menu|places]}" && pwd -P)
scene=${2:-main}
kit=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
. "$w/env.sh"
layouts="$HERDR_APP_HOME/layouts"

# The stage's PATH has no node: look where it usually is (the real home, not the stage's).
real_home=$(eval echo "~$(id -un)")
node_bin=${NODE:-}
for n in "$real_home/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -n "$node_bin" ] || { [ -x "$n" ] && node_bin=$n; }
done
[ -n "$node_bin" ] || { echo "showcase.sh: needs node (NODE=/path/to/node)" >&2; exit 2; }

shown() { herdr-app status | sed -n 's/.*"layout": *"\([^"]*\)".*/\1/p' | head -1; }
file() { echo "$layouts/$(shown).json"; }
apply() { # apply <file>: shows that tree as the current layout (and saves it)
  herdr-app do layout.set --layout "$(cat "$1")" >/dev/null
  sleep 1
}
place() { # place <add|remove> <place>...: what Show in… does
  "$node_bin" "$kit/place.mjs" "$(file)" "$@" > "$w/stats-layout.json"
  apply "$w/stats-layout.json"
}
edit() { # edit <python expression on `l`, the layout>: sizes, edges, hidden
  /usr/bin/python3 - "$(file)" "$1" > "$w/stats-layout.json" <<'PY'
import json, sys
l = json.load(open(sys.argv[1]))
def node(i, n=None):
    n = l if n is None else n
    if n.get("id") == i:
        return n
    for c in n.get("children", []):
        hit = node(i, c)
        if hit:
            return hit
    return None
def floating(i):
    return next(f for f in l.get("floating", []) if f.get("id") == i)
exec(sys.argv[2])
print(json.dumps(l))
PY
  apply "$w/stats-layout.json"
}
close() { herdr-app do overlay.close >/dev/null 2>&1 || :; }

main() {
  # Back to the cockpit's places, in case another scene ran before.
  place remove left tabs float
  edit 'l["floating"] = [f for f in l.get("floating", []) if f.get("id") != "stats-menu-demo"]'
  place add right status
  # The right sidebar's three panels share it by weight: the stats get the most, so they draw
  # their tall column (440 pt and up) with the CPU chart, cores, memory, sensors and terminals.
  # (Added again after the places scene, they come last: put them back between the two.)
  edit 'col = node("sidebar-right"); s = node("stats-right"); col["children"].remove(s); col["children"].insert(1, s)
node("prs")["size"] = {"weight": 1}; s["size"] = {"weight": 2.4}; node("running-right")["size"] = {"weight": 1}
node("tabs")["hidden"] = True'
}

case $scene in
  main)
    close
    main
    ;;
  dashboard)
    close
    main
    # The dashboard asks the sampler for the process list as it opens; it comes a few seconds later.
    herdr-app do mod.open --name herdr-stats >/dev/null
    sleep 6
    ;;
  menu)
    close
    main
    # In the app the menu is a popup from the ⋯ of any copy; here it's a floating block of its
    # own at the top of the window, the same view, so it can be pictured without a click.
    edit 'l.setdefault("floating", []).append({"id": "stats-menu-demo", "content": {"mod": "herdr-stats", "props": {"view": "menu"}}, "edge": "top", "align": "center"})'
    ;;
  places)
    close
    main
    edit 'l["floating"] = [f for f in l.get("floating", []) if f.get("id") != "stats-menu-demo"]'
    place remove right
    place add left tabs float
    # The stage's layout hides the tab bar (pane headers do its job): show it, with the stats
    # at its end. The drawer peeks from the right edge, between the pull requests and Running.
    edit 'node("stats-wrap-tabs").pop("hidden", None); floating("stats-float").update({"edge": "right", "align": "center"})'
    ;;
  *)
    echo "showcase.sh: unknown scene $scene" >&2
    exit 2
    ;;
esac
