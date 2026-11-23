#!/usr/bin/env bash
# Records `git status` output for the repository states the parser is tested
# against. Each state is built in its own mktemp directory, and the raw output
# of the plugin's exact status command is written to tests/fixtures/<state>.z.
#
#   tests/fixtures/record.sh            # re-record every state
#
# The recorded files are committed; `npm run check` does not re-record. Dates
# and identities are pinned so object ids are stable across runs on the same
# git version.
set -euo pipefail

out="$(cd "$(dirname "$0")" && pwd)"
live="$out/../live"
work="$(mktemp -d "${TMPDIR:-/tmp}/gs-record.XXXXXX")"
trap 'rm -rf "$work"' EXIT

export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

STATUS=(--no-optional-locks status --porcelain=v2 --branch -z -uall)

new_repo() {
  local d="$work/$1"
  git init -q -b main "$d"
  git -C "$d" config commit.gpgsign false
  echo "$d"
}

record() {
  local name="$1" d="$2"
  shift 2
  git -C "$d" "$@" "${STATUS[@]}" > "$out/$name.z"
  echo "recorded $name.z"
}

# staged + modified again (MM), plus a plain staged add and an unstaged edit.
d=$(new_repo mm)
printf 'one\n' > "$d/f.txt"; printf 'x\n' > "$d/other.txt"
git -C "$d" add -A; git -C "$d" commit -q -m base
printf 'two\n' > "$d/f.txt"; git -C "$d" add f.txt; printf 'three\n' > "$d/f.txt"
printf 'y\n' > "$d/other.txt"
printf 'n\n' > "$d/added.txt"; git -C "$d" add added.txt
record mm "$d"

# rename, staged.
d=$(new_repo rename)
mkdir -p "$d/src"; printf 'content that stays the same\nline 2\n' > "$d/src/old.ts"
git -C "$d" add -A; git -C "$d" commit -q -m base
mkdir -p "$d/lib"; git -C "$d" mv src/old.ts lib/new.ts
record rename "$d"

# copy, staged (shown only with copy detection on).
d=$(new_repo copy)
printf 'content that is copied\nline 2\nline 3\n' > "$d/orig.txt"
git -C "$d" add -A; git -C "$d" commit -q -m base
cp "$d/orig.txt" "$d/copy.txt"; printf 'edit\n' >> "$d/orig.txt"; git -C "$d" add -A
record copy "$d" -c status.renames=copies

# conflicts: UU (both modified), AA (both added), DU (deleted by us).
d=$(new_repo conflict)
printf 'base\n' > "$d/uu.txt"; printf 'base\n' > "$d/du.txt"
git -C "$d" add -A; git -C "$d" commit -q -m base
git -C "$d" checkout -q -b other
printf 'theirs\n' > "$d/uu.txt"; printf 'theirs\n' > "$d/du.txt"; printf 'theirs\n' > "$d/aa.txt"
git -C "$d" add -A; git -C "$d" commit -q -m theirs
git -C "$d" checkout -q main
printf 'ours\n' > "$d/uu.txt"; git -C "$d" rm -q du.txt; printf 'ours\n' > "$d/aa.txt"
git -C "$d" add -A; git -C "$d" commit -q -m ours
git -C "$d" merge -q other >/dev/null 2>&1 || true
record conflict "$d"

# git rm --cached: D in Staged and ? in Changes for the same path.
d=$(new_repo rm-cached)
printf 'kept on disk\n' > "$d/f.txt"
git -C "$d" add -A; git -C "$d" commit -q -m base
git -C "$d" rm -q --cached f.txt
record rm-cached "$d"

# git add -N (intent to add): .A
d=$(new_repo intent-to-add)
printf 'x\n' > "$d/base.txt"; git -C "$d" add -A; git -C "$d" commit -q -m base
printf 'new\n' > "$d/n.txt"; git -C "$d" add -N n.txt
record intent-to-add "$d"

# unborn branch: no commits yet, one staged and one untracked file.
d=$(new_repo unborn)
printf 'a\n' > "$d/a.txt"; git -C "$d" add a.txt; printf 'b\n' > "$d/b.txt"
record unborn "$d"

# detached HEAD with a modified file.
d=$(new_repo detached)
printf '1\n' > "$d/f.txt"; git -C "$d" add -A; git -C "$d" commit -q -m one
printf '2\n' > "$d/f.txt"; git -C "$d" commit -q -am two
git -C "$d" checkout -q --detach HEAD~1
printf '3\n' > "$d/f.txt"
record detached "$d"

# upstream: 2 ahead, 1 behind.
o="$work/upstream.origin.git"; git init -q --bare -b main "$o"
d=$(new_repo upstream)
printf '0\n' > "$d/f.txt"; git -C "$d" add -A; git -C "$d" commit -q -m base
git -C "$d" remote add origin "$o"; git -C "$d" push -q -u origin main
c="$work/upstream-clone"; git clone -q "$o" "$c"; git -C "$c" config commit.gpgsign false
printf 'r\n' > "$c/remote.txt"; git -C "$c" add -A; git -C "$c" commit -q -m remote; git -C "$c" push -q
printf '1\n' > "$d/f.txt"; git -C "$d" commit -q -am l1
printf '2\n' > "$d/f.txt"; git -C "$d" commit -q -am l2
git -C "$d" fetch -q
record upstream "$d"

# upstream gone: branch.upstream present, no branch.ab.
o="$work/gone.origin.git"; git init -q --bare -b main "$o"
d=$(new_repo upstream-gone)
printf '0\n' > "$d/f.txt"; git -C "$d" add -A; git -C "$d" commit -q -m base
git -C "$d" remote add origin "$o"; git -C "$d" push -q -u origin main
git -C "$d" update-ref -d refs/remotes/origin/main
record upstream-gone "$d"

# paths with spaces and non-ASCII characters (no quoting under -z).
d=$(new_repo unicode)
mkdir -p "$d/dir with space"; printf '1\n' > "$d/dir with space/naïve file.txt"
git -C "$d" add -A; git -C "$d" commit -q -m base
printf '2\n' > "$d/dir with space/naïve file.txt"
printf 'u\n' > "$d/ünï cødé.md"
git -C "$d" mv "dir with space/naïve file.txt" "dir with space/naïve → renamed.txt" 2>/dev/null || true
record unicode "$d"

# clean repository.
d=$(new_repo clean)
printf 'x\n' > "$d/f.txt"; git -C "$d" add -A; git -C "$d" commit -q -m base
record clean "$d"

# the acceptance fixture (spec "Acceptance criteria"), built by the live
# checks' own script so the two cannot drift apart.
d=$(GS_LIVE_BASE="$work" "$live/fixture.sh" acceptance)
record acceptance "$d"
