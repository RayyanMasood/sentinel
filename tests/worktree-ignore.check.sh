#!/bin/sh
# The member snapshot's git add against real git, in five layouts. The old command (always excluding .claude/worktrees)
# fails once an ignored worktree folder exists on git 2.52; the new one (exclude only when git doesn't ignore it) must
# exit 0 everywhere and never stage a worktree. Usage: bash tests/worktree-ignore.check.sh
set -u
base=$(mktemp -d)
trap 'rm -rf "$base"' EXIT
fail=0
snap() { # $1 repo, $2 old|new: prints "<exit> <worktree entries staged>"
  ix="$base/$(basename "$1").$2.index"; rm -f "$ix"
  GIT_INDEX_FILE="$ix" git -C "$1" read-tree HEAD
  ex=":(exclude).claude/worktrees"
  if [ "$2" = new ] && GIT_INDEX_FILE="$ix" git -C "$1" check-ignore -q .claude/worktrees/; then ex=; fi
  GIT_INDEX_FILE="$ix" git -C "$1" -c core.safecrlf=false add -A -- . $ex 2>/dev/null; rc=$?
  n=$(GIT_INDEX_FILE="$ix" git -C "$1" ls-files -s | grep -c '^160000\|\.claude/worktrees/')
  echo "$rc $n"
}
layout() { # $1 name, $2 .gitignore line ('' for none), $3 empty|worktree|absent
  r="$base/$1"; git init -q "$r"; [ -n "$2" ] && printf '%s\n' "$2" > "$r/.gitignore"; echo a > "$r/a.txt"
  git -C "$r" -c core.autocrlf=false add -A; git -C "$r" -c user.name=x -c user.email=x@x commit -qm init
  case $3 in
    empty) mkdir -p "$r/.claude/worktrees" ;;
    worktree) git -C "$r" worktree add -q --detach .claude/worktrees/w1 HEAD; echo u > "$r/.claude/worktrees/w1/u.txt" ;;
  esac
  old=$(snap "$r" old); new=$(snap "$r" new)
  echo "$1: old exit/staged=$old, new exit/staged=$new"
  [ "$new" = "0 0" ] || { echo "  FAIL: the new command must exit 0 and stage no worktree"; fail=1; }
}
git --version
layout ignored-empty '.claude/worktrees/' empty
layout ignored-worktree '.claude/worktrees/' worktree
layout ignored-parent '.claude/' worktree
layout ignored-absent '.claude/worktrees/' absent
layout not-ignored-worktree '' worktree
exit $fail
