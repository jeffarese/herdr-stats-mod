#!/bin/sh
# Install the herdr-stats mod into the Herdr app, update it, or take it out.
#
#   ./install.sh            copy mods/herdr-stats in, bind ⌥⌘S, open the dashboard
#   ./install.sh --remove   take it out of your layouts, stop its sampler, delete it
#
# Without a clone, the script fetches the rest itself:
#
#   curl -fsSL https://raw.githubusercontent.com/jeffarese/herdr-stats-mod/main/install.sh | sh
#
# The app's home is ~/.config/herdr-app, or $HERDR_APP_HOME. Needs python3.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
dest="$home/mods/herdr-stats"
app=$(command -v herdr-app 2>/dev/null || echo "$HOME/.local/bin/herdr-app")

[ -d "$home/mods" ] || { echo "No Herdr app home at $home. Start the Herdr app once first." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "The installer needs python3." >&2; exit 1; }
running() { [ -x "$app" ] && "$app" status >/dev/null 2>&1; }

# Run from a pipe, or from a copy of this file alone: fetch the rest.
if [ ! -f "$here/mods/herdr-stats/main.js" ] || [ ! -f "$here/scripts/install.py" ]; then
  tarball=${HERDR_STATS_TARBALL:-https://github.com/jeffarese/herdr-stats-mod/archive/refs/heads/main.tar.gz}
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$tarball" | tar -xz -C "$tmp" --strip-components 1
  [ -f "$tmp/mods/herdr-stats/main.js" ] || { echo "Couldn't fetch the mod from $tarball" >&2; exit 1; }
  here=$tmp
fi

if [ "${1:-}" = "--remove" ]; then
  python3 "$here/scripts/install.py" layouts remove
  python3 "$here/scripts/install.py" keys remove
  python3 "$here/scripts/install.py" sampler stop
  rm -rf "$dest"
  case "$(uname -s)" in
    Darwin) rm -rf "$HOME/Library/Caches/herdr-stats" ;;
    *) rm -rf "$HOME/.cache/herdr-stats" ;;
  esac
  echo "Removed herdr-stats."
  exit 0
fi

was_there=0
[ -d "$dest" ] && was_there=1
mkdir -p "$dest/bin"
cp "$here"/mods/herdr-stats/*.js "$here"/mods/herdr-stats/*.json "$here"/mods/herdr-stats/*.svg "$dest/"
if [ "$(uname -s)" = Darwin ]; then
  bin="$here/mods/herdr-stats/bin/herdr-stats-sampler"
  if [ ! -x "$bin" ] && command -v cargo >/dev/null 2>&1 && [ -f "$here/sampler/Cargo.toml" ]; then
    sh "$here/scripts/build-sampler.sh"
  fi
  [ -x "$bin" ] || { echo "No sampler binary at $bin, and no cargo to build it." >&2; exit 1; }
  # Beside, then renamed over: a sampler running from the old file keeps it until it retires.
  cp "$bin" "$dest/bin/.herdr-stats-sampler.new"
  chmod +x "$dest/bin/.herdr-stats-sampler.new"
  mv -f "$dest/bin/.herdr-stats-sampler.new" "$dest/bin/herdr-stats-sampler"
fi

if [ -x "$app" ]; then "$app" check "$dest"; fi
python3 "$here/scripts/install.py" keys add
if [ $was_there = 1 ]; then
  echo "Updated herdr-stats. Herdr reloads it by itself."
elif running; then
  "$app" do mod.open --name herdr-stats >/dev/null
  echo "Installed. The dashboard is open in Herdr: Show in… puts the stats in a sidebar, a bar or a drawer."
else
  echo "Installed. With Herdr open, press ⌥⌘S (or run: herdr-app do mod.open --name herdr-stats)."
fi
