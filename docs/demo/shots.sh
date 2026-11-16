#!/bin/sh
# Installs the mod on a stage (stage.sh) and takes the README's pictures.
#
#   sh docs/demo/shots.sh <stage folder>
#
# preview.png                the left sidebar panel and the status bar line, beside a build
# docs/media/dashboard.png   the dashboard (⌥⌘S)
# docs/media/menu.png        the Show in… menu
# docs/media/places.png      the other places: tab bar, right sidebar and floating drawer
#
# The app draws each picture itself (`herdr-app shot`), so no screen recording is involved.
set -eu
kit=$(cd "$(dirname "$0")" && pwd)
repo_root=$(cd "$kit/../.." && pwd)
node_bin=$(command -v node)
w=${1:?usage: shots.sh <stage folder>}
# shellcheck disable=SC1091
. "$w/env.sh"
mkdir -p "$repo_root/docs/media"
layouts="$HERDR_APP_HOME/layouts"

# The app draws a new frame only while its window can be seen, so the stage's comes to the
# front for each picture.
shoot() { # shoot <file>
  osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $(cat "$w/app.pid")) to true" >/dev/null
  sleep 4
  herdr-app shot "$1" >/dev/null
}
place() { # place <add|remove> <place>...: what Show in… does, on the shown layout
  name=$(herdr-app status | sed -n 's/.*"layout": *"\([^"]*\)".*/\1/p')
  herdr-app do layout.set --layout "$("$node_bin" "$kit/place.mjs" "$layouts/$name.json" "$@")" >/dev/null
  sleep 1
}

# The installer, as anyone runs it: it opens the dashboard, which starts the sampler.
sh "$repo_root/install.sh" >/dev/null
herdr-app do overlay.close >/dev/null

# Two spaces: an agent writing tests and a release build in "shop", a dev server in "api".
# Arguments: cores on average, kind, swing, period in seconds (standin.c).
herdr-app do space.new --name shop --folder "$HOME/code/shop" --argv '["claude","0.4","agent","0.6","9"]' >/dev/null
herdr-app do tab.new --name build --folder "$HOME/code/shop" --argv '["cargo","4.5","build","0.7","23"]' >/dev/null
herdr-app do space.new --name api --folder "$HOME/code/api" --argv '["node","0.15","dev","0.5","6"]' >/dev/null
herdr-app do space.select --index 1 >/dev/null
herdr-app do tab.select --index 2 >/dev/null

# The left sidebar and the status bar, on a personal copy of Herdr's layout (as the menu
# makes one). Two minutes in, the charts have a history across their width.
herdr-app do layout.clone --name main --as main-stats >/dev/null
sleep 1
place add left status
sleep 120
shoot "$repo_root/preview.png"

# The dashboard asks the sampler for the process list as it opens; it comes a few seconds later.
herdr-app do mod.open --name herdr-stats >/dev/null
sleep 6
shoot "$repo_root/docs/media/dashboard.png"
herdr-app do overlay.close >/dev/null

# The menu, in a floating block of its own at the top of the window (in the app it opens
# from the ⋯ of any copy), cut out of the picture with some of the window around it.
floating() { # floating <json of a floating entry>: adds it to the shown layout
  python3 - "$layouts/main-stats.json" "$1" <<'PY'
import json, sys
path, entry = sys.argv[1], json.loads(sys.argv[2])
layout = json.load(open(path))
layout["floating"] = [f for f in layout.get("floating", []) if f.get("id") != entry["id"]] + [entry]
json.dump(layout, open(path + ".next", "w"))
PY
  herdr-app do layout.set --layout "$(cat "$layouts/main-stats.json.next")" >/dev/null
  rm "$layouts/main-stats.json.next"
  sleep 1
}
floating '{"id":"stats-menu-demo","content":{"mod":"herdr-stats","props":{"view":"menu"}},"edge":"top","align":"center"}'
shoot "$w/menu-full.png"
# 2x pictures: the menu is 270 px wide at the window's centre.
width=$(sips -g pixelWidth "$w/menu-full.png" | awk '/pixelWidth/ {print $2}')
sips --cropToHeightWidth 1020 760 --cropOffset 0 $(( (width - 760) / 2 )) "$w/menu-full.png" --out "$repo_root/docs/media/menu.png" >/dev/null

# The other places: the end of the tab bar, the right sidebar, and the drawer on the left edge.
python3 - "$layouts/main-stats.json" <<'PY'
import json, sys
path = sys.argv[1]
layout = json.load(open(path))
layout["floating"] = [f for f in layout.get("floating", []) if f.get("id") != "stats-menu-demo"]
json.dump(layout, open(path, "w"))
PY
place remove left status
place add tabs right float
floating '{"id":"stats-float","content":{"mod":"herdr-stats","props":{"spot":"float"}},"edge":"left","align":"end","peek":58}'
shoot "$repo_root/docs/media/places.png"
