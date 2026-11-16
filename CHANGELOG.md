# Changelog

The mod and its sampler share one version: the sampler's (`sampler/Cargo.toml`), which the
dashboard's footer shows.

## 0.1.2

First public release.

- Five places from one menu (**Show in…**): left sidebar, right sidebar, status bar, tab bar and
  a floating drawer, each drawn to fit its room; a dashboard on ⌥⌘S.
- CPU with per-core cells split into performance and efficiency cores, memory as app, wired and
  compressed, GPU, network, disk, temperatures and fans, each with a history.
- Every terminal ranked by CPU and memory, from herdr-core's map of terminals to their shells;
  the busiest one in the sidebar, one click away.
- One sampler for every copy, about 0.3% of one core and 8 MB. It exits 30 s after the last copy
  stops checking in, so switching layouts never interrupts it and closing Herdr never leaves it
  behind.
- Disk use counts everything not available on the disk, as Finder does, not just the data
  volume's own blocks (75%, not 58%, on a disk with a quarter free).
- Per-process CPU is converted from Apple Silicon's Mach ticks; before, terminals and processes
  read about 42 times too low.
- Linux reads `/proc` in the mod itself when there is no sampler binary.
