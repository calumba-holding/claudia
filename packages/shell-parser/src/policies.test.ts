import { describe, expect, it } from "bun:test";

import { evaluatePolicy } from "./policies";
import { parseShell } from "./parse";

async function policy(command: string) {
  return evaluatePolicy(await parseShell(command));
}

describe("shell policy", () => {
  it("skips tokf for explicit gh JSON and jq projections", async () => {
    await expect(
      policy("gh pr view 24824 --json number,headRefName -q '{num: .number, head: .headRefName}'"),
    ).resolves.toMatchObject({ ok: true, denyReason: null, skipTokf: true });

    await expect(policy("gh pr view 24824")).resolves.toMatchObject({
      ok: true,
      denyReason: null,
      skipTokf: false,
    });
  });

  it("skips tokf for source search commands", async () => {
    await expect(policy("rg required client/src | sed -n '1,40p'")).resolves.toMatchObject({
      ok: true,
      denyReason: null,
      skipTokf: true,
    });

    await expect(policy("git grep -n BadgeType -- client/src")).resolves.toMatchObject({
      ok: true,
      denyReason: null,
      skipTokf: true,
    });
  });

  it("denies grep-style rg compact replace flag misuse", async () => {
    const lineNumberResult = await policy("rg -rn 'Clear filters' client/src --glob '*.tsx'");
    expect(lineNumberResult.denyReason).toContain("rg -rn");

    const filesResult = await policy("rg -rl 'Clear filters' client/src --glob '*.tsx'");
    expect(filesResult.denyReason).toContain("rg -rl");

    await expect(policy("rg -n 'Clear filters' client/src --glob '*.tsx'")).resolves.toMatchObject({
      ok: true,
      denyReason: null,
      skipTokf: true,
    });

    await expect(policy("rg -l 'Clear filters' client/src --glob '*.tsx'")).resolves.toMatchObject({
      ok: true,
      denyReason: null,
      skipTokf: true,
    });
  });

  it("denies gh-stack only when the CLI command flows to tail or head", async () => {
    const direct = await policy("gh-stack submit | tail -15");
    expect(direct.denyReason).toContain("gh-stack");

    const chained = await policy("true && gh-stack restack | head -5");
    expect(chained.denyReason).toContain("gh-stack");

    const subshell = await policy("( gh-stack submit ) | tail -5");
    expect(subshell.denyReason).toContain("gh-stack");
  });

  it("does not deny gh-stack when it appears as argument data", async () => {
    await expect(
      policy("gh issue view 14 -R kiliman/gh-stack --json title -q .title | head"),
    ).resolves.toMatchObject({
      ok: true,
      denyReason: null,
      skipTokf: true,
    });

    const token = "gh-" + "stack";
    const command = `viz=$(gh pr view 24907 --json body --jq '.body' | sed -n '/<!-- ${token}/,/${token} -->/p'); gh pr edit 24907 --title 'x' --body-file /tmp/final.md | tail -2`;
    await expect(policy(command)).resolves.toMatchObject({
      ok: true,
      denyReason: null,
      skipTokf: true,
    });
  });

  it("denies destructive tmux command invocations only", async () => {
    const denied = await policy("tmux kill-server");
    expect(denied.denyReason).toContain("tmux kill-server");

    const quoted = await policy("tmux kill'-server'");
    expect(quoted.denyReason).toContain("tmux kill-server");

    await expect(policy("echo 'tmux kill-server'")).resolves.toMatchObject({
      ok: true,
      denyReason: null,
    });
  });

  it("denies two-dot ranges in git diff", async () => {
    const review = await policy("git diff origin/main..HEAD -- client/src/interfaces/foo.ts");
    expect(review.denyReason).toContain("three dots");

    const noPathspec = await policy("git diff origin/main..abc1234");
    expect(noPathspec.denyReason).toContain("three dots");

    // Global flags must not hide the subcommand behind their own value.
    const dashC = await policy("git -C /repo diff main..HEAD");
    expect(dashC.denyReason).toContain("three dots");

    // Ancestor pairs are denied too, and correctly so: three-dot returns the
    // identical result there, so the advice is never wrong.
    const ancestor = await policy("git diff HEAD~2..HEAD");
    expect(ancestor.denyReason).toContain("three dots");
  });

  it("does not deny three-dot diffs, git log ranges, or paths containing dots", async () => {
    for (const command of [
      "git diff origin/main...HEAD -- client/src/interfaces/foo.ts",
      "git log --oneline origin/main..HEAD", // two-dot is correct for log
      "git diff origin/main HEAD", // space form: the deliberate tip-vs-tip escape hatch
      "git diff",
      "git diff --staged",
      "git diff main -- ../other/path",
      "git diff main -- a/../b",
      "echo 'git diff main..HEAD'",
    ]) {
      await expect(policy(command)).resolves.toMatchObject({ ok: true, denyReason: null });
    }
  });
});
