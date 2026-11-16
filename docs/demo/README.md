# The README's pictures

[preview.png](../../preview.png) and the pictures in [docs/media](../media) show the real mod in
the real Herdr app, on a stage that is synthetic from end to end. Nothing in them comes from a
real project, person or machine name.

**Real:** the Herdr app, herdr-core, this repository's mod, its sampler and its installer, and
the readings themselves (CPU, memory, disk, temperatures of the Mac that takes them).

**Synthetic:**

- **The programs.** [standin.c](standin.c), compiled as `claude`, `cargo` and `node`, prints a
  few plausible lines and keeps some cores busy, in waves, so the charts have a shape and the
  terminal list has something to rank. They read and write nothing.
- **The host name and process list.** The stage runs the sampler with
  `HERDR_STATS_HOST=studio`, and with `HERDR_STATS_TOP_UNDER` set to the stage's folder, so the
  busiest processes are the stage's own programs, never the rest of the Mac's.
- **The projects.** `~/code/shop` and `~/code/api` are empty folders.
- **The app.** A second Herdr app whose home is in the stage, with its own herdr-core, the
  welcome already seen and usage reports off.

Nothing of yours is read or written, and your own spaces don't show.

## Take them again

```sh
sh docs/demo/record.sh
```

It needs the Herdr app, herdr-core, Node, python3 and a C compiler (`xcode-select --install`).
The app draws the pictures itself (`herdr-app shot`), so no screen recording permission is
involved. A run takes about three minutes, most of it letting the charts fill.

- **[stage.sh](stage.sh)** builds the stand-ins, starts the core and the second app, and prints
  the stage's folder. `stage.sh --down <folder>` stops everything and deletes it.
- **[shots.sh](shots.sh)** runs the installer, opens two spaces and takes the pictures, placing
  the stats with [place.mjs](place.mjs), which is the mod's own placement code.
- **[record.sh](record.sh)** runs both and takes the stage down.

Before you run it:

- **The second app's window comes to the front for each picture,** because the app only draws
  while its window can be seen. Keys you type meanwhile go to it; its terminals don't show them.
- **The stand-ins keep up to about eight cores busy** while it runs.
- **Starting the Herdr app installs an app update that was waiting,** as any start does.
