#!/usr/bin/env python3
"""PreToolUse guard: reject `git diff A..B` when A and B have diverged.

Two-dot diffs compare tips, so commits the base gained after the fork render as
deletions by the author -- a false "this PR reverted X" finding. Three-dot
diffs from the merge base and is what a PR review wants.

Only fires when it actually matters: if A is an ancestor of B, `..` and `...`
are identical and the command passes untouched. Fails open on any error.
"""
import json
import re
import subprocess
import sys

REF = r"[A-Za-z0-9_./@{}~^-]+"
TWO_DOT = re.compile(rf"(?<![A-Za-z0-9_./@{{}}~^-])({REF})\.\.(?!\.)({REF})")


def git(args, cwd):
    return subprocess.run(
        ["git"] + args, cwd=cwd, capture_output=True, text=True, timeout=5
    )


def main():
    raw = sys.stdin.read()
    data = json.loads(raw)
    cmd = data.get("tool_input", {}).get("command", "") or ""
    cwd = data.get("cwd") or None

    if "GIT_DIFF_TWO_DOT_OK=1" in cmd:
        return
    # `git diff` only. `git log A..B` two-dot is correct and idiomatic.
    if not re.search(r"\bgit\b(?:\s+-C\s+\S+)?(?:\s+--\S+)*\s+diff\b", cmd):
        return

    # Refs live left of the `--` pathspec separator; paths may legitimately hold "..".
    head = re.split(r"\s--\s", cmd)[0]

    for seg in head.split("&&"):
        for a, b in TWO_DOT.findall(seg):
            if a.startswith(".") or b.startswith("."):
                continue
            if any(git(["rev-parse", "--verify", "-q", f"{r}^{{commit}}"], cwd).returncode
                   for r in (a, b)):
                continue  # unresolvable -> not our business
            if git(["merge-base", "--is-ancestor", a, b], cwd).returncode == 0:
                continue  # no divergence: .. and ... are identical here

            behind = git(["rev-list", "--count", f"{b}..{a}"], cwd).stdout.strip() or "?"
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    f"Two-dot diff across diverged refs: `{a}..{b}`.\n"
                    f"`{a}` is {behind} commits ahead of `{b}`, and every one of them "
                    f"will render as a DELETION by the author.\n\n"
                    f"Use three dots:  git diff {a}...{b}\n\n"
                    f"Arbiter if a finding alleges a deletion: "
                    f"gh pr view <PR> --json files  (merge-base computed; -0 means your diff is wrong).\n"
                    f"Deliberate tip-vs-tip compare? prefix GIT_DIFF_TWO_DOT_OK=1"
                ),
            }}))
            sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # fail open: never break the session over a lint
