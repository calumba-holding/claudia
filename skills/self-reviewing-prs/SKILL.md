---
name: self-reviewing-prs
description: "MUST be used right after opening a PR of my own, before asking anyone to review it. Covers the self-review pass: which judgment calls earn an inline comment, how to post them with gh-comment (which is NOT the same command as a general PR comment), and the pre-submit comment sweep. Triggers on: self-review, self review, review my own PR, review my PR, after creating a PR, opened a PR, just pushed a PR, pre-review pass, annotate my diff, explain my tradeoffs, flag my judgment calls, inline self-review, review before requesting review, PR is ready for review."
---

# Self-Reviewing My Own PRs

The pass I do on **my own** diff after opening the PR and before a human or bot arrives.

> **Mechanics live in `reviewing-prs-with-claudia`.** That skill has the full `gh comment` /
> `gh pr-review` reference — batch syntax, thread resolution, the fork's line-mapping, the
> APPROVE-event flakiness. This skill is the _discipline_, plus the handful of traps specific
> to reviewing my own work. Load both when posting a self-review.

## Why this exists as its own skill

`reviewing-prs-with-claudia` did not fire when I self-reviewed, because its description says
"reviewing GitHub PRs" and I read my own PR as a different activity. I then re-derived the CLI
from `--help` and got it wrong on the first try. **The knowledge was there; the trigger wasn't.**
That is the whole reason this file exists — so keep the trigger list above greedy.

## The one-line rule

> A questioned decision costs a review round-trip. A **pre-explained** decision usually costs
> nothing, because the reviewer can see it was weighed rather than missed.

## What earns an inline self-review comment

Post one wherever a competent reviewer would stop and ask "why did you do it _that_ way?"

| Earns a comment                                                                               | Does not                               |
| --------------------------------------------------------------------------------------------- | -------------------------------------- |
| A deliberate divergence from a sibling implementation                                         | Anything the diff already says plainly |
| A guard whose enforcement lives **outside the diff** (base branch, a concern, a parent class) | Restating the commit message           |
| An assertion that looks redundant but is load-bearing                                         | "Added X, removed Y" narration         |
| An ordering, fallback, or trade-off with a visible edge case                                  | Apologising for scope                  |
| Exposition cut from a code comment during the sweep                                           | Anything better fixed than explained   |

**The highest-value one, consistently:** _a guard that is real but invisible in the diff._ Both bot
and human reviewers on stacked work repeatedly flag things as missing when they live one PR down or
in an included concern. Naming where the guard actually lives pre-empts an entire round.

**Say the tradeoff, why this side won, and that you'll invert it on request.** A self-review comment
that only justifies reads defensive; one that names the cost and opens the door reads like
engineering.

## Where cut exposition goes

During the pre-submit comment sweep, code comments get tightened hard (source terse, specs looser).
Whatever was worth saying and did not survive the trim **lands here** — an inline self-review comment
on the PR. That is the release valve that makes terse source comments safe: the reviewer still gets
the full reasoning, and the next reader of that function does not pay for it on every visit.

## Order of operations

1. `gh pr create --draft` (always draft in swarm).
2. **Comment sweep** the whole diff — print the base first so "I swept" cannot silently mean
   "I swept my last two commits":
   ```bash
   BASE=$(git merge-base origin/main HEAD) && echo "sweeping $BASE..HEAD"
   git diff $BASE...HEAD | grep "^+" | grep -E "//|/\*| \* |^\+\s*#"
   ```
   Then hunt comments the diff **falsified**, including ones outside the diff whose claims the new
   code broke.
3. **Mutation-test any new test** before you vouch for it (see below).
4. Post the inline self-review comments.
5. Only then ask for review.

## Mutation-test before you claim a regression test works

A regression test that passes against the _unfixed_ code is worse than no test — it certifies
nothing while looking like proof.

**Never use `git stash` for this.** `git stash push -- <path>` on a path with no uncommitted
changes saves nothing and **fails silently** — so once the fix is committed, the "reverted" run is
actually running against the fix and reports a meaningless green. Worse, the paired `git stash pop`
then pops whatever unrelated stash happens to be at `stash@{0}`, straight into your tree. That
happened: it popped a stranger's `do-not-keep` stash and left a conflicted file that blocked
committing entirely, and rubocop failed on the conflict markers rather than on anything of mine.

Use a plain file copy instead. No git, nothing to clobber, works identically whether the fix is
committed or not:

```bash
cp <file> /tmp/keep.rb                       # snapshot
# neuter the fix in place (make the new method return nil, revert the changed line, …)
<run the spec>                                # expect RED, EVERY example
cp /tmp/keep.rb <file>                        # restore
git diff --stat HEAD -- <file>                # MUST be empty — proves a clean restore
<run the spec>                                # expect GREEN, whole file
```

Always run the **whole spec file** on the green pass, not just the new context — the probe may have
perturbed something else.

**The trap this catches most often:** `expect { … }.not_to change(…)`. When the bug causes a
rollback or a raise, _nothing changes_ — so the negative assertion goes green for entirely the wrong
reason. Fix by anchoring it with a positive assertion in the same example
(`expect(result).to be_success`), then **leave a code comment saying the anchor is load-bearing**,
or someone will delete it as redundant. Post an inline self-review comment on it too — it is the
single most deletable line in the diff.

## CLI traps (the ones I actually hit)

**`gh comment add` is not the self-review command.** It posts a general conversation comment and has
**no `--body-file` flag**. Line-specific comments come from `gh comment review`:

```bash
gh comment review <PR> "Self-review — flagging the judgment calls before anyone has to ask." \
  --comment "app/services/foo.rb:211:$(cat /tmp/c1.md)" \
  --comment "app/services/foo.rb:221:$(cat /tmp/c2.md)" \
  --comment "spec/services/foo_spec.rb:831:$(cat /tmp/c3.md)" \
  --event COMMENT --validate
```

- Bodies go in files and come in via `$(cat …)` — multi-paragraph markdown inline in a shell arg is
  a formatting minefield.
- `--validate` confirms the line is actually in the diff. Cheap; use it.
- Line numbers are **post-change file line numbers**, not diff offsets. Get them with
  `grep -n` on the working tree, not by counting hunk lines.
- `--event COMMENT` is correct here. A self-review can never be APPROVE.
- Verify placement afterwards — a comment on the wrong line is worse than none:
  ```bash
  gh api repos/<owner>/<repo>/pulls/<PR>/comments --jq '.[] | "\(.path):\(.line) → \(.body[0:70])"'
  ```

**A `PostToolUse` formatter can mangle a `.rb` written to `/tmp`.** Writing a Ruby block to a temp
file and splicing it in came back de-indented by two and with every double quote flipped to single —
matching neither the target file nor rubocop. **Read back the region after splicing**, before running
anything. Editing the real file directly with a script avoids the hook entirely.

**dcg blocks the console/heredoc idioms.** Two separate rules, both false positives on our patterns:
`heredoc.shell:launcher-unverified` (a markdown code fence whose line starts with a backtick) and
`heredoc.posix:eval-dynamic` (Ruby `eval <<~'SCRIPT'` written to a file — the shell never evals it).
**Do not evade a dcg block.** Write the file with the `Write` tool instead — no shell, no heredoc,
nothing bypassed — and tell Michael it tripped so it can go upstream.

## Writing the comment body

Lead with a bolded one-line claim so it reads in the collapsed preview, then the reasoning, then the
invitation. Keep it to three short paragraphs.

```markdown
**Tradeoff — <the choice>, not <the obvious alternative>.**

<Why the alternative was rejected, in terms of what would drift or duplicate.>

<The cost of the choice, named honestly.> Happy to invert it if you'd rather — but I'd want
<the thing that must not be lost> handled deliberately rather than by omission.
```

## When a reviewer finds something anyway

1. **Verify the claim against the code first.** Bots are most convincing when wrong.
2. Check whether it is on the base before believing "this doesn't exist":
   `git log -1 -S"<symbol>" -- <path>` and `git show origin/main:<path> | grep -c "<symbol>"`.
3. Verify the _suggested fix_ separately from the finding — a real finding can carry a fix that
   makes things worse.
4. Fix on the PR that owns the code, reply saying what changed **including where the fix went beyond
   the suggestion and why**, then resolve the thread.
