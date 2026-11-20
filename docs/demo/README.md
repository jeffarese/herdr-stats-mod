# The README's pictures

[preview.png](../../preview.png) and the pictures in [docs/media](../media) show the real mod in
the real Herdr app, on the showcase stage: one made-up Herdr window that every one of these mods'
READMEs pictures, with all the mods running together. Sam works at Acme on a laptop and a Mac
Studio; the spaces (shop, api, web, docs, search), the agents, the pull requests, the servers
and the toasts are all made up. Nothing in the pictures comes from a real project, person or
machine.

**Real:** the Herdr app, herdr-core, this repository's mod as the working tree has it (with its
sampler), the other mods from their own repositories, and the readings themselves: CPU, memory,
temperatures and fans of the Mac that takes the pictures.

**Made up:** everything the readings are about. The terminals run the stage's stand-ins, so the
busiest terminal is the Claude Code stand-in in shop (it keeps about 0.7 of a core busy), and
the sampler runs with `HERDR_STATS_HOST=sams-macbook` and `HERDR_STATS_TOP_UNDER` set to the
stage's folder, so the host is Sam's and the busiest processes are the stage's own.

The stage itself, its cast and its stand-ins are the showcase kit's, in
`~/workspace/herdr/herdr-showcase` (a local folder, not part of this repository; its `README.md`
and `BRIEF.md` explain it).

## The scenes

- **[showcase.sh](showcase.sh)** is this mod's hook for the kit. With no scene it sets the main
  one, which the kit's `stage.sh` runs after its default scene: the stats get the larger share
  of the right sidebar (weights 1, 2.4 and 1 beside the pull requests and Running), so they draw
  their tall column, and a line of them goes at the end of the status bar. `dashboard` opens the
  dashboard over that; `menu` puts the Show in… menu in a floating block at the top of the
  window (in the app it is a popup from the `⋯` of any copy); `places` takes the stats out of
  the right sidebar and puts them in the left sidebar, the tab bar (which the stage's layout
  otherwise hides) and a drawer on the right edge, beside the status bar line.
- Every place is added and taken out with the mod's own placement code, through
  **[place.mjs](place.mjs)**, which is what Show in… does. The hook only sets the sizes, the
  drawer's edge and the tab bar's visibility.
- **[showcase-shots.sh](showcase-shots.sh)** runs the scenes one after another and takes each
  picture with the kit's `shoot.sh`, which waits until nobody has typed for a minute.

## Take them again

```sh
w=$(SHOWCASE_TFVPN=0 SHOWCASE_HOOK=$PWD/docs/demo/showcase.sh sh ~/workspace/herdr/herdr-showcase/stage.sh)
sleep 120                               # the charts fill their width in two minutes
sh docs/demo/showcase-shots.sh "$w"
sh ~/workspace/herdr/herdr-showcase/stage.sh --down "$w"
```

`SHOWCASE_TFVPN=0` because this README is public: the VPN switch stays out of the pictures.
Run from the repository's root. The pictures are 3200 × 1942 (the window at 2x); the menu is a
crop of its picture (`MENU_CROP`, in pixels: x,y,width,height). One scene at a time, to look
before shooting:

```sh
sh docs/demo/showcase.sh "$w" places
sh ~/workspace/herdr/herdr-showcase/shoot.sh "$w" /tmp/places.png
```

## The older stage

[stage.sh](stage.sh), [shots.sh](shots.sh), [record.sh](record.sh) and [standin.c](standin.c)
made the README's earlier pictures on a stage of their own (stand-ins named `claude`, `cargo`
and `node` in two spaces). They no longer make any of the README's pictures and are kept as
they were. `place.mjs` is shared with the showcase hook.
