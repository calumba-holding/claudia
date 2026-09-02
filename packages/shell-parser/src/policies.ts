import type { ParseResult, PolicyResult, ShellCommand } from "./types";

const GH_STACK_TAIL_DENY =
  "Blocked: don't pipe gh-stack into tail/head. It can hang the wrapper or get killed mid-operation (exit 143), leaving a rebase/push half-done. Re-run plainly; use 'tokf raw last' for the full output.";

const RG_REPLACE_DENY =
  "Blocked: don't use grep-style compact ripgrep flags like 'rg -rn' or 'rg -rl'. In ripgrep, -r means --replace, so '-rn' replaces matches with 'n' and '-rl' replaces matches with 'l', corrupting source-looking output. Use 'rg -n' for line numbers or 'rg -l' for filenames; ripgrep searches recursively by default.";

const TMUX_KILL_SERVER_DENY =
  "Blocked: tmux kill-server would terminate the tmux-wrap session and may kill the agent CLI itself. Tell Michael tmux is broken and ask him to restart or repair the tmux wrapper/session instead.";

const GIT_DIFF_TWO_DOT_DENY =
  "Blocked: 'git diff A..B' compares the two tips, so every commit B's base gained after the branch forked renders as a DELETION by the author — which reads as the PR reverting a teammate's work. This produced a false finding twice in review. Use three dots ('git diff A...B'), which diffs from the merge base: when B is already up to date the two are identical, so three dots is never worse. If a finding alleges a deletion, check 'gh pr view <PR> --json files' — it is merge-base computed, so -0 deletions means the diff is wrong, not the PR. Genuinely want a tip-vs-tip compare? Use 'git diff A B' (space, no dots), which is what '..' means.";

// git's own global flags that consume the next argv entry, so the subcommand
// isn't mistaken for their value (`git -C /repo diff` -> "diff", not "/repo").
const GIT_VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--exec-path",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
]);

const TWO_DOT_RANGE = /^([^\s]+?)\.\.(?!\.)([^\s]*)$/;

function gitSubcommandIndex(argv: string[]): number {
  let i = 1;
  while (i < argv.length) {
    const token = argv[i];
    if (!token.startsWith("-")) return i;
    i += GIT_VALUE_FLAGS.has(token) ? 2 : 1;
  }
  return -1;
}

function hasTwoDotRange(argv: string[], start: number): boolean {
  for (let i = start; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") return false; // pathspecs from here on; "a/../b" is not a range
    if (token.startsWith("-") || token.startsWith(".")) continue;

    const match = TWO_DOT_RANGE.exec(token);
    if (!match) continue;

    const [, left, right] = match;
    // `left` ending in "." is the lazy match backtracking into "A...B"; a "/"
    // on either side of the dots means it's a path such as "a/../b".
    if (!left || left.endsWith(".") || left.endsWith("/") || right.startsWith("/")) continue;
    return true;
  }
  return false;
}

function hasCompactRgReplaceFlagMisuse(argv: string[]): boolean {
  return argv.some((arg) => {
    if (!arg.startsWith("-") || arg.startsWith("--")) return false;
    const flags = arg.slice(1);
    return flags.includes("r") && (flags.includes("n") || flags.includes("l"));
  });
}

function hasGhJsonProjection(argv: string[]): boolean {
  return argv.some(
    (arg) =>
      arg === "--json" ||
      arg.startsWith("--json=") ||
      arg === "--jq" ||
      arg.startsWith("--jq=") ||
      arg === "-q",
  );
}

function isSourceSearch(command: ShellCommand): boolean {
  if (["rg", "grep", "egrep", "fgrep"].includes(command.name)) return true;
  return command.name === "git" && command.argv[1] === "grep";
}

function isTailOrHead(command: ShellCommand): boolean {
  return command.name === "tail" || command.name === "head";
}

function pipelineCommands(parse: ParseResult, command: ShellCommand): ShellCommand[] {
  if (command.pipelineId === null) return [command];
  return parse.commands
    .filter((candidate) => candidate.pipelineId === command.pipelineId)
    .sort((a, b) => (a.pipelineIndex ?? 0) - (b.pipelineIndex ?? 0));
}

function flowsToTailOrHead(parse: ParseResult, command: ShellCommand): boolean {
  const pipeline = pipelineCommands(parse, command);
  const index = pipeline.findIndex((candidate) => candidate.id === command.id);
  if (index < 0) return false;
  return pipeline.slice(index + 1).some(isTailOrHead);
}

export function evaluatePolicy(parse: ParseResult): PolicyResult {
  if (!parse.ok) {
    return {
      ok: false,
      denyReason: null,
      skipTokf: false,
      fallback: "parse-error",
      warnings: parse.error ? [parse.error] : [],
    };
  }

  for (const command of parse.commands) {
    if (command.name === "rg" && hasCompactRgReplaceFlagMisuse(command.argv.slice(1))) {
      return { ok: true, denyReason: RG_REPLACE_DENY, skipTokf: false, warnings: [] };
    }

    if (command.name === "gh-stack" && flowsToTailOrHead(parse, command)) {
      return { ok: true, denyReason: GH_STACK_TAIL_DENY, skipTokf: false, warnings: [] };
    }

    if (command.name === "tmux" && command.argv[1] === "kill-server") {
      return { ok: true, denyReason: TMUX_KILL_SERVER_DENY, skipTokf: false, warnings: [] };
    }

    if (command.name === "git") {
      const subcommand = gitSubcommandIndex(command.argv);
      if (
        subcommand > 0 &&
        command.argv[subcommand] === "diff" &&
        hasTwoDotRange(command.argv, subcommand + 1)
      ) {
        return { ok: true, denyReason: GIT_DIFF_TWO_DOT_DENY, skipTokf: false, warnings: [] };
      }
    }
  }

  const skipTokf = parse.commands.some((command) => {
    if (isSourceSearch(command)) return true;
    return command.name === "gh" && hasGhJsonProjection(command.argv.slice(1));
  });

  return { ok: true, denyReason: null, skipTokf, warnings: [] };
}
