#!/bin/sh
# Takes the README's pictures on a showcase stage, with the kit's shoot.sh, one scene of
# showcase.sh after another, and leaves the stage on the main scene.
#
#   w=$(SHOWCASE_TFVPN=0 SHOWCASE_HOOK=$PWD/docs/demo/showcase.sh sh ~/workspace/herdr/herdr-showcase/stage.sh)
#   sleep 120                                  # the charts fill their width in two minutes
#   sh docs/demo/showcase-shots.sh "$w"
#   sh ~/workspace/herdr/herdr-showcase/stage.sh --down "$w"
#
# preview.png                the stats tall in the right sidebar, and in the status bar, the
#                            rest of the window dimmed
# docs/media/dashboard.png   the dashboard (⌥⌘S) over the window
# docs/media/menu.png        the Show in… menu, cut out of a picture of the window
# docs/media/places.png      the left sidebar, the tab bar, the status bar and the drawer
#
# Each picture waits until nobody has typed for a minute (shoot.sh), so a run takes a few minutes.
set -eu
w=$(cd "${1:?usage: showcase-shots.sh <stage>}" && pwd -P)
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
kit=${SHOWCASE_KIT:-$HOME/workspace/herdr/herdr-showcase}
shoot() { sh "$kit/shoot.sh" "$w" "$@"; }
scene() { sh "$here/showcase.sh" "$w" "$1"; }

scene main
# The stats lit (the panel and the status bar's metrics), the rest of the window dimmed.
shoot "$w/preview-raw.png"
sh "$kit/spot.sh" "$w/preview-raw.png" "$repo/preview.png" right:2 status

scene dashboard
shoot "$repo/docs/media/dashboard.png"

# The menu is 270 pt wide at zoom 0.9, in the middle of the top edge: the picture is the menu
# with a little of the window around it, at 2x.
scene menu
shoot "$repo/docs/media/menu.png" --crop "${MENU_CROP:-1300,0,600,930}"

scene places
shoot "$repo/docs/media/places.png"

scene main
