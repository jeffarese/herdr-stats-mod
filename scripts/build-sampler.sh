#!/bin/sh
# Build the sampler and put it where the mod looks for it (mods/herdr-stats/bin).
# Herdr's macOS build is Apple Silicon only; so is the binary this commits.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# The binary is committed: map build paths to neutral ones so it names nobody's home folder.
RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME/.cargo=/cargo --remap-path-prefix=$here=/src --remap-path-prefix=$HOME=/home" \
  cargo build --release --manifest-path "$here/sampler/Cargo.toml"
mkdir -p "$here/mods/herdr-stats/bin"
cp "$here/sampler/target/release/herdr-stats-sampler" "$here/mods/herdr-stats/bin/herdr-stats-sampler"
"$here/mods/herdr-stats/bin/herdr-stats-sampler" --version
