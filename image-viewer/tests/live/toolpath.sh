#!/usr/bin/env bash
# toolpath.sh DIR [--with TOOL]... [--fake-ffmpeg] : makes DIR a PATH
# directory of symlinks to sh, base64, chmod, rm and the core tools Fresh
# and the driver use, with no ffmpeg, ImageMagick or sips (A13). `--with ffmpeg`
# links a tool in, which is the "tools back" step; `--fake-ffmpeg` links
# tests/live/fake-ffmpeg as ffmpeg (A14). Prints DIR.
#
# Each call sets DIR's image tools afresh: the ones an earlier call linked are
# unlinked first, so a reused DIR has exactly the tools this call names. Only
# symlinks with those four names are removed. An image tool that is still
# there and was not asked for (a regular file) makes it exit 1.
set -euo pipefail
DIR=$1
shift
HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE_TOOLS=(ffmpeg magick convert sips)
mkdir -p "$DIR"
for t in "${IMAGE_TOOLS[@]}"; do
  if [[ -L $DIR/$t ]]; then rm -f "$DIR/$t"; fi
done
link() { # name [target]; a tool not found is skipped
  local t=${2:-$(PATH=/usr/bin:/bin:/usr/sbin:/sbin command -v "$1" || true)}
  # An `if`, not `[[ … ]] && ln`: that returns 1 for a missing tool, and
  # under `set -e` the call then ends the script.
  if [[ -n $t ]]; then ln -sfn "$t" "$DIR/$1"; fi
}
for t in sh bash base64 chmod rm cat env grep sed ls mkdir sleep date tr head tail uname dirname basename readlink; do link "$t"; done
asked=" "
while [[ $# -gt 0 ]]; do
  case $1 in
    --with) t=$(command -v "$2") || { echo "toolpath: no $2" >&2; exit 1; }; ln -sfn "$t" "$DIR/$2"; asked+="$2 "; shift 2 ;;
    --fake-ffmpeg) ln -sfn "$HERE/fake-ffmpeg" "$DIR/ffmpeg"; asked+="ffmpeg "; shift ;;
    *) echo "toolpath: unknown $1" >&2; exit 2 ;;
  esac
done
for t in "${IMAGE_TOOLS[@]}"; do
  if [[ -e $DIR/$t && $asked != *" $t "* ]]; then
    echo "toolpath: $DIR/$t is not a symlink this script made; remove it, or pick another DIR" >&2
    exit 1
  fi
done
echo "$DIR"
