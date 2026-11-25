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

# a merge in progress: one conflicted file (UU) and one staged file.
d=$(new_repo merge)
printf 'base\n' > "$d/uu.txt"; printf 'x\n' > "$d/s.txt"
git -C "$d" add -A; git -C "$d" commit -q -m base
git -C "$d" checkout -q -b other
printf 'theirs\n' > "$d/uu.txt"; git -C "$d" commit -q -am theirs
git -C "$d" checkout -q main
printf 'ours\n' > "$d/uu.txt"; git -C "$d" commit -q -am ours
git -C "$d" merge -q other >/dev/null 2>&1 || true
printf 'y\n' > "$d/s.txt"; git -C "$d" add s.txt
record merge "$d"

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

# a tracked file deleted and replaced by a directory that holds an untracked
# file and a nested repository: ` D foo` next to `? foo/x` and `? foo/sub/`.
d=$(new_repo deleted-dir)
printf 'was a file\n' > "$d/foo"; printf 'k\n' > "$d/keep"
git -C "$d" add -A; git -C "$d" commit -q -m base
rm "$d/foo"; mkdir -p "$d/foo"; printf 'u\n' > "$d/foo/x"
git init -q -b main "$d/foo/sub"; printf 's\n' > "$d/foo/sub/s"
git -C "$d/foo/sub" add -A; git -C "$d/foo/sub" commit -q -m s
record deleted-dir "$d"

# symbolic links: a tracked link retargeted (.M, 120000 on every side), a
# file replaced by a link (.T, worktree 120000), a link retargeted and
# staged (M.), a file replaced by a link and staged (T.), and an untracked
# link (?, which carries no mode).
d=$(new_repo symlink)
printf 'a\n' > "$d/a.txt"; printf 'b\n' > "$d/b.txt"
printf 'f\n' > "$d/file.txt"; printf 'g\n' > "$d/staged-file.txt"
ln -s a.txt "$d/link"; ln -s a.txt "$d/staged-link"
git -C "$d" add -A; git -C "$d" commit -q -m base
ln -sfn b.txt "$d/link"
rm "$d/file.txt"; ln -s b.txt "$d/file.txt"
ln -sfn b.txt "$d/staged-link"; git -C "$d" add staged-link
rm "$d/staged-file.txt"; ln -s b.txt "$d/staged-file.txt"; git -C "$d" add staged-file.txt
ln -s a.txt "$d/new-link"
record symlink "$d"

# clean repository.
d=$(new_repo clean)
printf 'x\n' > "$d/f.txt"; git -C "$d" add -A; git -C "$d" commit -q -m base
record clean "$d"

# the acceptance fixture (spec "Acceptance criteria"), built by the live
# checks' own script so the two cannot drift apart.
d=$(GS_LIVE_BASE="$work" "$live/fixture.sh" acceptance)
record acceptance "$d"

# ---------------------------------------------------------------------------
# The Graph (R30–R33): `git log`, `diff-tree` and `show` outputs, with the
# plugin's exact argv (lib/history.ts: `logArgs`, `filesArgs`, `showArgs`),
# each ending its revisions with `--`.
# Each commit gets its own pinned time, one second after the last, so ids are
# stable and newer commits are newer.
# ---------------------------------------------------------------------------

LOG=(--no-optional-locks log --topo-order --no-show-signature --no-color --decorate=full '--decorate-refs-exclude=refs/remotes/*/HEAD' -z -n 51 '--format=%H%x00%P%x00%D%x00%an%x00%s')
SHOW=(--no-optional-locks show --no-color --no-show-signature --format=fuller --stat --patch --first-parent --root)

tick=0
at() {
  tick=$((tick + 1))
  local t
  t=$(printf '2026-01-01T%02d:%02d:%02dZ' $((tick / 3600)) $((tick / 60 % 60)) $((tick % 60)))
  GIT_AUTHOR_DATE="$t" GIT_COMMITTER_DATE="$t" "$@"
}
# commit <dir> <subject> [file]: write <subject> to <file> (default <subject>.txt) and commit it.
commit() {
  local d="$1" s="$2" f="${3:-$2.txt}"
  printf '%s\n' "$s" > "$d/$f"
  git -C "$d" add -A
  at git -C "$d" commit -q -m "$s"
}
merge() {
  local d="$1" s="$2"
  shift 2
  at git -C "$d" merge -q --no-ff -m "$s" "$@" >/dev/null
}
record_log() {
  local name="$1" d="$2"
  shift 2
  git -C "$d" "${LOG[@]}" "$@" -- > "$out/log-$name.z"
  echo "recorded log-$name.z"
}

# A straight line: c1 (root) to c5, no upstream.
d=$(new_repo log-line)
for c in c1 c2 c3 c4 c5; do commit "$d" "$c"; done
record_log line "$d" HEAD

# A30's history: main c1 (root) → c2, tagged v1 (and annotated v1a) → c3;
# feat from c2 with f1, f2; main merges feat as M (parents c3, f2), then c4.
# origin/main is at M (↑1), and origin/HEAD points at it: excluded.
o="$work/a30.origin.git"; git init -q --bare -b main "$o"
d=$(new_repo log-a30)
commit "$d" c1; commit "$d" c2; git -C "$d" tag v1; at git -C "$d" tag -a -m "annotated" v1a; commit "$d" c3
git -C "$d" checkout -q -b feat HEAD~1; commit "$d" f1; commit "$d" f2
git -C "$d" checkout -q main; merge "$d" M feat
git -C "$d" remote add origin ../a30.origin.git; git -C "$d" push -q -u origin main 2>/dev/null
git -C "$o" symbolic-ref HEAD refs/heads/main; git -C "$d" remote set-head origin -a >/dev/null
commit "$d" c4
record_log a30 "$d" HEAD '@{upstream}'
a30="$d"

# Two merges whose lanes cross: x and y both start at a; main is a → b → c.
# M1 merges y, M2 merges x, so x's lane runs past the lanes M1 opened.
d=$(new_repo log-cross)
commit "$d" a
git -C "$d" checkout -q -b x; commit "$d" x1
git -C "$d" checkout -q main; commit "$d" b
git -C "$d" checkout -q -b y; commit "$d" y1
git -C "$d" checkout -q main; commit "$d" c
merge "$d" M1 y; merge "$d" M2 x
record_log cross "$d" HEAD

# An octopus merge of three branches.
d=$(new_repo log-octopus)
commit "$d" base
for b in p q r; do git -C "$d" checkout -q -b "$b" main; commit "$d" "$b"1; done
git -C "$d" checkout -q main; commit "$d" m1
merge "$d" octopus p q r
record_log octopus "$d" HEAD

# Diverged from the upstream: two local commits, one remote commit fetched.
o="$work/div.origin.git"; git init -q --bare -b main "$o"
d=$(new_repo log-diverged)
commit "$d" base; git -C "$d" remote add origin ../div.origin.git; git -C "$d" push -q -u origin main 2>/dev/null
c="$work/div-clone"; git clone -q "$o" "$c" 2>/dev/null; git -C "$c" config commit.gpgsign false
commit "$c" remote1; git -C "$c" push -q 2>/dev/null
commit "$d" local1; commit "$d" local2; git -C "$d" fetch -q
record_log diverged "$d" HEAD '@{upstream}'

# Two roots: an unrelated history merged in.
d=$(new_repo log-roots)
commit "$d" r1; commit "$d" r2
git -C "$d" checkout -q --orphan other; git -C "$d" rm -q -rf .; commit "$d" o1; commit "$d" o2
git -C "$d" checkout -q main; merge "$d" join --allow-unrelated-histories other
record_log roots "$d" HEAD

# A shallow clone (--depth 2) of the straight line: its last commit's
# parents are missing, `%P` is empty and `%D` says `grafted`.
d="$work/log-shallow"
git clone -q --depth 2 "file://$work/log-line" "$d" 2>/dev/null
record_log shallow "$d" HEAD

# A detached HEAD on the straight line.
git -C "$work/log-line" checkout -q --detach HEAD~1
record_log detached "$work/log-line" HEAD
git -C "$work/log-line" checkout -q main

# 60 commits: more than the 50 the first page shows.
d=$(new_repo log-long)
for i in $(seq -w 1 60); do commit "$d" "n$i" n.txt; done
record_log long "$d" HEAD

# One commit's files against its first parent, one kind of change each.
DT=(--no-optional-locks diff-tree -r -z --raw -M)
record_dt() {
  local name="$1" d="$2" id
  id=$(git -C "$d" rev-parse HEAD)
  git -C "$d" "${DT[@]}" "${@:3}" "$id^1" "$id" -- > "$out/difftree-$name.z"
  echo "recorded difftree-$name.z"
}
d=$(new_repo difftree)
printf 'root one\n' > "$d/one.txt"; printf 'root two\n' > "$d/two.txt"; mkdir -p "$d/dir"; printf 'kept\n' > "$d/dir/kept.txt"
printf 'content that is renamed\nline 2\nline 3\n' > "$d/before.txt"
printf 'content that is copied\nline 2\nline 3\n' > "$d/orig.txt"
printf 'a file that becomes a link\n' > "$d/typechange"
git -C "$d" add -A; at git -C "$d" commit -q -m root
git -C "$d" "${DT[@]}" --root --no-commit-id "$(git -C "$d" rev-parse HEAD)" -- > "$out/difftree-root.z"; echo "recorded difftree-root.z"
printf 'added\n' > "$d/dir/added.txt"; git -C "$d" add -A; at git -C "$d" commit -q -m add; record_dt add "$d"
git -C "$d" mv before.txt dir/after.txt; printf 'changed\n' >> "$d/one.txt"; git -C "$d" add -A; at git -C "$d" commit -q -m rename; record_dt rename "$d"
cp "$d/orig.txt" "$d/copy.txt"; printf 'edit\n' >> "$d/orig.txt"; git -C "$d" add -A; at git -C "$d" commit -q -m copy
# Copies show only with copy detection: the plugin's -M lists copy.txt as A
# (difftree-copy-m), and -C as C with its source (difftree-copy).
record_dt copy-m "$d"; record_dt copy "$d" -C
git -C "$d" rm -q two.txt; at git -C "$d" commit -q -m delete; record_dt delete "$d"
git -C "$d" update-index --add --cacheinfo "160000,$(git -C "$d" rev-parse HEAD),sub"; at git -C "$d" commit -q -m gitlink; record_dt gitlink "$d"
ln -s one.txt "$d/link"; git -C "$d" add link; at git -C "$d" commit -q -m symlink; record_dt symlink "$d"
rm "$d/typechange"; ln -s one.txt "$d/typechange"; git -C "$d" add -A; at git -C "$d" commit -q -m typechange; record_dt typechange "$d"
# A merge, against its first parent: the files the merged branch brought.
record_dt_merge() {
  local id
  id=$(git -C "$a30" rev-parse HEAD~1)
  git -C "$a30" "${DT[@]}" "$id^1" "$id" -- > "$out/difftree-merge.z"
  echo "recorded difftree-merge.z"
}
record_dt_merge

# View Commit's text (R33): a merge (first parent) and a root commit.
git -C "$a30" "${SHOW[@]}" HEAD~1 -- > "$out/show-merge.txt"; echo "recorded show-merge.txt"
git -C "$a30" "${SHOW[@]}" "$(git -C "$a30" rev-list --max-parents=0 HEAD)" -- > "$out/show-root.txt"; echo "recorded show-root.txt"

# ---------------------------------------------------------------------------
# Pull and Push (R34–R36): rc, stdout and stderr of the plugin's argv
# (lib/remote.ts) for each outcome of INV §8 P38, against local bare
# remotes named by relative paths, so the outputs carry no temp directory.
# Run with the plugin's environment (lib/remote.ts `remoteEnv`), the C locale
# included.
# ---------------------------------------------------------------------------

export LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= SSH_ASKPASS=false SSH_ASKPASS_REQUIRE=force
record_remote() {
  local name="$1" d="$2" rc=0
  shift 2
  git -C "$d" "$@" > "$work/stdout" 2> "$work/stderr" || rc=$?
  { printf 'rc %s\n--- stdout\n' "$rc"; cat "$work/stdout"; printf -- '--- stderr\n'; cat "$work/stderr"; } > "$out/remote-$name.txt"
  echo "recorded remote-$name.txt"
}
PUSH=(push origin refs/heads/main:refs/heads/main)
PULL=(pull --tags --no-autostash origin refs/heads/main)
# A bare remote `<name>.git` with clones `<name>` (main tracking origin/main)
# and `<name>-2`, the other user.
remote_pair() {
  local o="$work/$1.git" a="$work/$1" b="$work/$1-2"
  git init -q --bare -b main "$o"
  git init -q -b main "$a"; git -C "$a" config commit.gpgsign false
  printf 'base\n' > "$a/f.txt"; git -C "$a" add -A; at git -C "$a" commit -q -m base
  git -C "$a" remote add origin "../$1.git"; git -C "$a" push -q -u origin main 2>/dev/null
  git -C "$work" clone -q "$1.git" "$1-2" 2>/dev/null; git -C "$b" config commit.gpgsign false
}

remote_pair push
record_remote push-up-to-date "$work/push" "${PUSH[@]}"
commit "$work/push" local1
record_remote push-ok "$work/push" "${PUSH[@]}"
record_remote push-other-name "$work/push" push origin refs/heads/main:refs/heads/other
git -C "$work/push-2" pull -q --ff-only 2>/dev/null; commit "$work/push-2" theirs1; git -C "$work/push-2" push -q 2>/dev/null
commit "$work/push" local2
record_remote push-rejected-fetch-first "$work/push" "${PUSH[@]}"
git -C "$work/push" fetch -q
record_remote push-rejected-non-ff "$work/push" "${PUSH[@]}"
git -C "$work/push" checkout -q -b topic
record_remote publish "$work/push" push -u origin refs/heads/topic:refs/heads/topic
record_remote push-no-remote "$work/push" push nowhere refs/heads/topic:refs/heads/topic
printf '#!/bin/sh\necho "remote: nope from the hook" >&2\nexit 1\n' > "$work/push.git/hooks/pre-receive"; chmod +x "$work/push.git/hooks/pre-receive"
commit "$work/push" topic1
record_remote push-hook-declined "$work/push" push origin refs/heads/topic:refs/heads/topic

remote_pair pull
record_remote pull-up-to-date "$work/pull" "${PULL[@]}"
commit "$work/pull-2" theirs1; at git -C "$work/pull-2" tag t1; git -C "$work/pull-2" push -q --tags origin main 2>/dev/null
record_remote pull-fast-forward "$work/pull" "${PULL[@]}"
commit "$work/pull-2" theirs2 f.txt; git -C "$work/pull-2" push -q 2>/dev/null
printf 'mine\n' > "$work/pull/f.txt"
record_remote pull-local-changes "$work/pull" "${PULL[@]}"
record_remote pull-rebase-unstaged "$work/pull" -c pull.rebase=true "${PULL[@]}"
# The user's autostash settings: --no-autostash overrides them, so git
# refuses as above instead of stashing (R34 never stashes).
record_remote pull-rebase-autostash "$work/pull" -c pull.rebase=true -c rebase.autoStash=true "${PULL[@]}"
record_remote pull-merge-autostash "$work/pull" -c merge.autoStash=true "${PULL[@]}"
git -C "$work/pull" checkout -q -- f.txt
commit "$work/pull" mine1 mine.txt
record_remote pull-diverged "$work/pull" "${PULL[@]}"
record_remote pull-ff-only-diverged "$work/pull" -c pull.ff=only "${PULL[@]}"
record_remote pull-rebase "$work/pull" -c pull.rebase=true "${PULL[@]}"
record_remote pull-no-remote-branch "$work/pull" pull --tags --no-autostash origin refs/heads/nosuch
commit "$work/pull-2" theirs3 f.txt; git -C "$work/pull-2" push -q 2>/dev/null
commit "$work/pull" "mine conflicting" f.txt
record_remote pull-conflict "$work/pull" -c pull.rebase=false "${PULL[@]}"
record_remote pull-unmerged "$work/pull" -c pull.rebase=false "${PULL[@]}"
git -C "$work/pull" add f.txt
record_remote pull-unconcluded-merge "$work/pull" -c pull.rebase=false "${PULL[@]}"
git -C "$work/pull" merge --abort
record_remote pull-rebase-conflict "$work/pull" -c pull.rebase=true "${PULL[@]}"
git -C "$work/pull" rebase --abort
# Only ahead of the upstream, with pull.rebase: rebase says "Current branch
# main is up to date.", not merge's "Already up to date.". Last, so no
# commit time after it moves.
git -C "$work/pull" reset -q --hard origin/main
printf 'ahead\n' > "$work/pull/ahead.txt"; git -C "$work/pull" add ahead.txt; at git -C "$work/pull" commit -q -m ahead
record_remote pull-rebase-up-to-date "$work/pull" -c pull.rebase=true "${PULL[@]}"

# Remotes that cannot be reached, or that want credentials: an ssh port
# nothing listens on, and an http server that answers only 401.
git -C "$work/push" remote add ssh-closed ssh://git@127.0.0.1:1/r.git
record_remote push-unreachable "$work/push" -c core.sshCommand='ssh -o BatchMode=yes -o ConnectTimeout=10' push ssh-closed refs/heads/main:refs/heads/main
port=18441
python3 -I -c '
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(401); self.send_header("WWW-Authenticate", "Basic realm=\"r\""); self.send_header("Content-Length", "0"); self.end_headers()
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
' "$port" &
srv=$!
trap 'kill "$srv" 2>/dev/null || true; rm -rf "$work"' EXIT
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 0.1; done
git -C "$work/pull" remote add h401 "http://127.0.0.1:$port/r.git"
record_remote pull-credentials "$work/pull" pull --tags --no-autostash h401 refs/heads/main
kill "$srv" 2>/dev/null || true
wait "$srv" 2>/dev/null || true
