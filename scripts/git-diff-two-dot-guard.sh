#!/bin/sh
# Cheap prefilter for the two-dot diff guard: only pay Python startup when the
# command could possibly be a `git diff A..B`. Everything else exits in ~3ms.
input=$(cat)
case "$input" in
  *diff*..*) ;;
  *) exit 0 ;;
esac
printf '%s' "$input" | exec python3 "$(dirname "$0")/git-diff-two-dot-guard.py"
