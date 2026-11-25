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
# Two names build other repositories instead, for the Graph (spec A29–A36):
#   graph       A30's history: main c1 (root) → c2, tagged v1 → c3; feat from
#               c2 with f1, f2; main merges feat as M (c3, f2), then c4.
#               origin/main is at M (↑1 ↓0) and origin/HEAD points at it.
#               c2 renames x.txt to y.txt and deletes gone.txt; c3 adds a
#               PNG. In the working tree b.md is modified, and two.txt (20
#               lines) has two changes. <base>/graph-2 is a second clone of
#               the same bare origin, for pushes from "someone else".
#   graph-long  120 commits on one line, for Load more.
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

if [ "$name" = graph-long ]; then
  git init -q -b main "$dir"
  for i in $(seq -w 1 120); do printf '%s\n' "$i" > "$dir/n.txt"; g add n.txt; g commit -q -m "n$i"; done
  echo "$dir"
  exit 0
fi

if [ "$name" = graph ]; then
  second="$base/$name-2"
  rm -rf "$second"
  git init -q -b main "$dir"
  git init -q --bare -b main "$origin"
  printf 'export const a = 1;\n' > "$dir/a.ts"
  printf '# b\n' > "$dir/b.md"
  printf 'content that is renamed\nline 2\nline 3\n' > "$dir/x.txt"
  printf 'export const gone = 1;\n' > "$dir/gone.txt"
  seq 1 20 | sed 's/^/line /' > "$dir/two.txt"
  g add -A; g commit -q -m c1
  g mv x.txt y.txt; g rm -q gone.txt; printf 'export const a = 2;\n' > "$dir/a.ts"; g add -A; g commit -q -m c2
  g tag v1
  # A 1x1 PNG.
  printf '\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89\0\0\0\rIDATx\x9cc\xf8\xff\xff?\0\x05\xfe\x02\xfe\xa7\x35\x81\x84\0\0\0\0IEND\xaeB`\x82' > "$dir/logo.png"
  g add logo.png; g commit -q -m c3
  g checkout -q -b feat HEAD~1
  printf 'one\n' > "$dir/feat.txt"; g add feat.txt; g commit -q -m f1
  printf 'one\ntwo\n' > "$dir/feat.txt"; g commit -q -am f2
  g checkout -q main
  g merge -q --no-ff -m M feat
  g remote add origin "$origin"
  g push -q -u origin main
  git -C "$origin" symbolic-ref HEAD refs/heads/main
  g remote set-head origin -a >/dev/null
  printf 'export const a = 4;\n' > "$dir/a.ts"; g commit -q -am c4
  git clone -q "$origin" "$second"
  # The working tree: b.md modified, two.txt with two changes.
  printf '# b\nchanged\n' > "$dir/b.md"
  sed -i.bak -e 's/^line 5$/line 5 changed/' -e 's/^line 15$/line 15 changed/' "$dir/two.txt" && rm "$dir/two.txt.bak"
  echo "$dir"
  exit 0
fi

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
