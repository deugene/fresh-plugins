#!/usr/bin/env bash
# Builds the acceptance fixture (spec "Acceptance criteria") for live checks.
#
#   fixture.sh <name> [--devcontainer <image> | --volume]
#
# Creates <base>/<name> and prints its path. <base> is $GS_LIVE_BASE, by
# default $HOME/.cache/gs-live (colima shares only $HOME with containers);
# tests/fixtures/record.sh builds its acceptance state here too. The repository is on `main`, one commit
# ahead of its upstream, with:
#   a.ts      staged and modified again        b.md     modified, unstaged
#   new/c.txt, new/d.txt untracked             old.ts   renamed to moved.ts, staged
#   gone.ts   deleted, unstaged                build/   ignored
#
# --devcontainer <image>  adds .devcontainer/devcontainer.json using <image>,
#                         with the workspace bind-mounted (the default).
# --volume                adds a devcontainer.json whose workspace is the
#                         `gs-vol` container volume instead of a bind mount.
# The .devcontainer/ directory (and a .fresh-cache/ ignore line) is
# committed, so the rows are the same as without it.
set -euo pipefail

name="${1:?usage: fixture.sh <name> [--devcontainer <image> | --volume]}"
shift
mode=none
image=""
# devcontainer.json lines only the volume workspace has.
volume_lines=""
case "${1:-}" in
  --devcontainer) mode=bind; image="${2:?--devcontainer needs an image}" ;;
  --volume)
    mode=volume
    image="mcr.microsoft.com/devcontainers/base:debian"
    volume_lines='
  "workspaceMount": "source=gs-vol,target=/workspaces/gs,type=volume",
  "workspaceFolder": "/workspaces/gs",'
    ;;
  "") ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

base="${GS_LIVE_BASE:-$HOME/.cache/gs-live}"
dir="$base/$name"
origin="$base/$name.origin.git"
rm -rf "$dir" "$origin"
mkdir -p "$dir"

g() { git -C "$dir" -c user.name=fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false "$@"; }

git init -q -b main "$dir"
git init -q --bare -b main "$origin"

printf 'build/\n' > "$dir/.gitignore"
# Fresh's dev-container attach writes build logs to .fresh-cache/ in the
# workspace and does not manage to ignore them itself (INV §8).
if [ "$mode" != none ]; then printf '.fresh-cache/\n' >> "$dir/.gitignore"; fi
printf 'export const a = 1;\n' > "$dir/a.ts"
printf '# b\n' > "$dir/b.md"
printf 'export const old = "old";\n// keep the content so git sees a rename\n' > "$dir/old.ts"
printf 'export const gone = 1;\n' > "$dir/gone.ts"

if [ "$mode" != none ]; then
  mkdir -p "$dir/.devcontainer"
  cat > "$dir/.devcontainer/devcontainer.json" <<EOF
{
  "name": "gs-$name",
  "image": "$image",$volume_lines
  "postCreateCommand": "git config --global --add safe.directory '*' || true"
}
EOF
fi

g add -A
g commit -q -m "initial"
g remote add origin "$origin"
g push -q -u origin main

# One commit the upstream does not have: main is ↑1 ↓0.
printf 'export const a = 1;\nexport const a2 = 2;\n' > "$dir/a.ts"
g commit -q -am "ahead"

# a.ts staged, then modified again.
printf 'export const a = 3;\n' > "$dir/a.ts"
g add a.ts
printf 'export const a = 4;\n' > "$dir/a.ts"
# old.ts -> moved.ts, staged.
g mv old.ts moved.ts
# b.md modified, unstaged.
printf '# b\nchanged\n' > "$dir/b.md"
# gone.ts deleted, unstaged.
rm "$dir/gone.ts"
# Untracked.
mkdir -p "$dir/new"
printf 'c\n' > "$dir/new/c.txt"
printf 'd\n' > "$dir/new/d.txt"
# Ignored.
mkdir -p "$dir/build"
printf 'ignored\n' > "$dir/build/out.js"

echo "$dir"
