#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
# Linux x86-64: one-command setup and a dev firmware build (./build.sh, identity FM-1_1000).
# Not a --release build. The JieLi clang runs natively; Docker is not used.
#   tools/ci_build.sh [REPO_DIR]
set -eu
ROOT="${1:-$(pwd)}"
cd "$ROOT"
: "${JIELI_TOOLCHAIN:=$HOME/.jieli/toolchain}"
: "${AC79_SDK:=$HOME/fw-AC79_AIoT_SDK}"
export JIELI_TOOLCHAIN AC79_SDK

if ! python3 -c 'import PIL.features; assert PIL.features.check("raqm")' >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libraqm-dev libfribidi-dev pkg-config python3-pip python3-dev
  python3 -m pip install --user 'Pillow>=10'
  python3 -c 'import PIL.features; assert PIL.features.check("raqm")'
fi

if [ ! -x "$JIELI_TOOLCHAIN/pi32v2/bin/clang" ]; then
  mkdir -p "${JIELI_TOOLCHAIN%/*}"
  curl -fL --retry 3 https://pkgman.jieliapp.com/s/linux-toolchain | tar -xJ -C "${JIELI_TOOLCHAIN%/*}"
  tc="$(ls -d "${JIELI_TOOLCHAIN%/*}"/jieli-linux-toolchains-* | sort | tail -1)"
  ln -sfn "$(basename "$tc")" "$JIELI_TOOLCHAIN"
fi

if [ ! -f "$AC79_SDK/cpu/wl82/tools/uboot.boot" ]; then
  git clone --filter=blob:none --sparse --depth 1 -b AC79NN_SDK_V1.2.1_2023-12-13 \
    https://gitee.com/Jieli-Tech/fw-AC79_AIoT_SDK.git "$AC79_SDK"
  git -C "$AC79_SDK" sparse-checkout set cpu/wl82/tools
fi
python3 - << PY
import hashlib
from pathlib import Path
root = Path("$AC79_SDK") / "cpu/wl82/tools"
want = {
    "uboot.boot": "4e3b4c220dc96641cb5a723f41e68ce41d5261ae9434bb33fbd7f2c59976ded4",
    "cfg_tool.bin": "276579954f076886a6a7694f65dc71c034a63a2c204b76749065c0ac7b010d1b",
    "cfg/eq_cfg_hw.bin": "41167491bffed4651750719c973d2758adeb9021a5670d02d6a53c85ed80ea7d",
}
for rel, exp in want.items():
    got = hashlib.sha256((root / rel).read_bytes()).hexdigest()
    if got != exp:
        raise SystemExit(f"{rel}: {got} != {exp}")
print("AC79 boot files match AC79NN_SDK_V1.2.1_2023-12-13")
PY

git submodule update --init --recursive
./build.sh
echo "package: app/build/loom.fwsc"
sha256sum app/build/loom.fwsc
