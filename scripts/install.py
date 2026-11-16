#!/usr/bin/env python3
"""The parts of installing herdr-stats that edit the person's files.

    install.py keys add       bind cmd-alt-s to the dashboard, unless the key is taken
    install.py keys remove    take that binding out again (only if it is still ours)
    install.py layouts remove take the stats out of every personal layout
    install.py sampler stop   end a running sampler (by its lock file, never by name)

The app's home is ~/.config/herdr-app, or $HERDR_APP_HOME. Herdr's own layouts are
never edited: the mod puts itself only into personal copies of them.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

APP_HOME = Path(os.environ.get("HERDR_APP_HOME", Path.home() / ".config/herdr-app"))
MOD = "herdr-stats"
ACTION = f"mod.open:{MOD}"
KEY = "cmd-alt-s"
WRAPS = {"stats-wrap-right", "stats-wrap-status", "stats-wrap-tabs"}


def write_json(path, value):
    temp = path.with_name(f".{path.name}.tmp")
    temp.write_text(json.dumps(value, indent=2) + "\n")
    temp.replace(path)


def keys(action):
    path = APP_HOME / "keys.json"
    if not path.exists():
        # Herdr writes the whole default set into keys.json on start; a file holding
        # only this key would drop every default. Say how instead.
        if action == "add":
            print(f"No keys.json yet: bind a key in Herdr with \"{KEY}\": \"{ACTION}\" in its global section.")
        return
    try:
        data = json.loads(path.read_text())
    except ValueError:
        print("keys.json isn't valid JSON right now; left it alone.")
        return
    glob = data.setdefault("global", {})
    if action == "add":
        if any(v == ACTION for section in data.values() if isinstance(section, dict) for v in section.values()):
            return
        if KEY in glob:
            print(f"{KEY} is already yours ({glob[KEY]}); bind the dashboard to another key: \"{ACTION}\".")
            return
        glob[KEY] = ACTION
        write_json(path, data)
        print("Bound ⌥⌘S (cmd-alt-s) to the dashboard.")
    elif glob.get(KEY) == ACTION:
        del glob[KEY]
        write_json(path, data)


def ours(node):
    content = node.get("content") if isinstance(node, dict) else None
    return isinstance(content, dict) and content.get("mod") == MOD and "view" not in (content.get("props") or {})


def strip(node):
    """Removes this mod's blocks under `node`, then unwraps rows/columns it made."""
    children = node.get("children")
    if not isinstance(children, list):
        return False
    changed = False
    kept = []
    for child in children:
        if ours(child):
            changed = True
            continue
        changed |= strip(child)
        if child.get("id") in WRAPS and len(child.get("children", [])) == 1:
            only = dict(child["children"][0])
            only.pop("size", None)
            for k in ("size", "min", "max", "hidden"):
                if k in child:
                    only[k] = child[k]
            child = only
            changed = True
        kept.append(child)
    node["children"] = kept
    return changed


def remove_from_layout(layout):
    changed = strip(layout)
    floating = layout.get("floating")
    if isinstance(floating, list):
        rest = [f for f in floating if not ours(f)]
        if len(rest) != len(floating):
            changed = True
            if rest:
                layout["floating"] = rest
            else:
                del layout["floating"]
    return changed


def shipped():
    try:
        return {k[len("layout:"):] for k in json.loads((APP_HOME / "installed.json").read_text()) if k.startswith("layout:")}
    except (OSError, ValueError):
        return {"main", "terminals", "win98"}


def layouts_remove():
    folder = APP_HOME / "layouts"
    herdrs = shipped()
    for path in sorted(folder.glob("*.json")):
        if path.stem in herdrs:
            continue
        try:
            layout = json.loads(path.read_text())
        except (OSError, ValueError):
            print(f"Skipped {path.name}: not valid JSON right now.")
            continue
        if remove_from_layout(layout):
            backup = path.with_name(f"{path.name}.before-stats")
            backup.write_text(path.read_text())
            write_json(path, layout)
            print(f"Took the stats out of {path.stem} (the old file is {backup.name}).")


def sampler_stop():
    cache = Path.home() / ("Library/Caches" if sys.platform == "darwin" else ".cache") / MOD
    lock = cache / "sampler.lock"
    try:
        pid = int(lock.read_text().split()[0])
    except (OSError, ValueError, IndexError):
        return
    # A lock file can outlive its sampler: only signal the pid if it is still ours.
    name = subprocess.run(["ps", "-p", str(pid), "-o", "comm="], capture_output=True, text=True).stdout.strip()
    if not name.endswith("herdr-stats-sampler"):
        return
    os.kill(pid, signal.SIGTERM)
    for _ in range(20):
        time.sleep(0.1)
        if subprocess.run(["ps", "-p", str(pid)], capture_output=True).returncode != 0:
            break
    print("Stopped the sampler.")


def main(argv):
    if argv[:2] == ["keys", "add"]:
        keys("add")
    elif argv[:2] == ["keys", "remove"]:
        keys("remove")
    elif argv[:2] == ["layouts", "remove"]:
        layouts_remove()
    elif argv[:2] == ["sampler", "stop"]:
        sampler_stop()
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
