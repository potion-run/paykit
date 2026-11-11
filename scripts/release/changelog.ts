/**
 * Release-note generation: `git log` → changelogen's conventional-commit
 * parser → `render.ts`.
 *
 * Ported from alchemy's `scripts/release/changelog.ts`: only the parser and
 * author dedupe are used (no GitHub token is ever passed, so authors are
 * never resolved to logins).
 *
 * Runs under node through Effect's `ChildProcessSpawner`. The log is read
 * through a pipe rather than a fixed buffer: `git log … --name-status`
 * prints every changed path of every commit in the range, so a release
 * spanning one repo-wide refactor overflows `execSync`'s 1 MB default and
 * the release dies at the tagging step having already bumped versions.
 */
import { parseCommits, type GitCommit, type RawGitCommit } from "changelogen";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Stream from "effect/Stream";
import { renderMarkdown, type RenderConfig } from "./render.ts";

export interface Commit extends GitCommit {
  /** Commit authors (incl. co-authors), deduped by email, bots dropped. */
  resolvedAuthors: Array<{ name: string; email: string }>;
}

export interface ChangelogOptions {
  /** Start of the range. Defaults to the closest tag before `to`. */
  from?: string;
  to: string;
  /**
   * The ref the footer's link names. Defaults to `to`. A release generates
   * its notes before the tag exists, so git reads `HEAD` while the link
   * already names the tag the release is about to create.
   */
  ref?: string;
  /** `<owner>/<repo>`. */
  repo: string;
}

const defaults = {
  types: {
    feat: { title: "🚀 Features" },
    fix: { title: "🐞 Bug Fixes" },
    perf: { title: "🏎 Performance" },
  },
  titles: { breakingChanges: "🚨 Breaking Changes" },
  emoji: true,
  capitalize: true,
  baseUrl: "github.com",
  scopeMap: {},
};

const excludeAuthors = [/\[bot\]/i, /dependabot/i, /\(bot\)/i];

export class GitFailed extends Data.TaggedError("GitFailed")<{
  readonly message: string;
  readonly args: ReadonlyArray<string>;
  readonly exitCode: number;
}> {}

/** Runs git, collecting stdout and stderr through pipes. */
const git = Effect.fn(function* (args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", [...args], { stdout: "pipe", stderr: "pipe" }),
      );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );

      return { stdout, stderr, exitCode: Number(exitCode) };
    }),
  );
});

/** The tag closest to `to`, excluding a tag on `to` itself. */
const previousTag = Effect.fn(function* (to: string) {
  const { stdout, exitCode } = yield* git(["describe", "--tags", "--abbrev=0", `${to}^`]);

  return exitCode === 0 ? stdout.trim() : undefined;
});

/**
 * Same command and record format as changelogen's `getGitDiff` (the `----`
 * separator and `|`-delimited header are what `parseCommits` expects).
 */
export const getGitDiff = Effect.fn(function* (from: string | undefined, to = "HEAD") {
  const args = [
    "--no-pager",
    "log",
    `${from ? `${from}...` : ""}${to}`,
    "--pretty=----%n%s|%h|%an|%ae%n%b",
    "--name-status",
  ];

  const { stdout, stderr, exitCode } = yield* git(args);

  if (exitCode !== 0) {
    return yield* new GitFailed({
      message: `git log ${from ?? ""}...${to} failed: ${stderr.trim()}`,
      args,
      exitCode,
    });
  }

  return stdout
    .trim()
    .split("----\n")
    .splice(1)
    .map((line): RawGitCommit => {
      const [firstLine, ..._body] = line.split("\n");
      const [message, shortHash, authorName, authorEmail] = (firstLine ?? "").split("|");

      return {
        message: message ?? "",
        shortHash: shortHash ?? "",
        author: { name: authorName ?? "", email: authorEmail ?? "" },
        body: _body.join("\n"),
      };
    });
});

/** Attaches `resolvedAuthors`, keeping the first name seen per email. */
const resolveAuthors = (commits: GitCommit[]): Commit[] => {
  const byEmail = new Map<string, { name: string; email: string }>();

  return commits.map((commit) => ({
    ...commit,
    resolvedAuthors: commit.authors.flatMap((a) => {
      if (!a.email || !a.name || excludeAuthors.some((re) => re.test(a.name))) return [];

      if (!byEmail.has(a.email)) byEmail.set(a.email, { name: a.name, email: a.email });

      return [byEmail.get(a.email)!];
    }),
  }));
};

export const generate = Effect.fn(function* (options: ChangelogOptions) {
  const from = options.from ?? (yield* previousTag(options.to));

  const config: RenderConfig = {
    ...defaults,
    repo: options.repo,
    from: from ?? "",
    to: options.ref ?? options.to,
  };

  const raw = yield* getGitDiff(from, options.to);

  // SAFETY: `parseCommits` reads only `config.scopeMap` off the config; every
  // other `RenderConfig` field is for `renderMarkdown`.
  const commits = resolveAuthors(parseCommits(raw, config as never));

  return { config, commits, md: renderMarkdown(commits, config) };
});
