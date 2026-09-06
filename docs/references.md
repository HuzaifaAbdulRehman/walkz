# Milestone 1 reference notes

These notes capture the parts of six public projects that answer a specific Walkz
design question. We used them only as references, and no source code was copied into
Walkz.

## reviewdog: index findings against the diff

We inspected <https://github.com/reviewdog/reviewdog> at
`3250b05a581b87a63e28caba333c0b150aa65a1e`.

- Build an index from normalized new-file paths and new-side line numbers.
- Treat added lines as the safest default location for an inline finding.
- Parse C-style quoted Git paths and test spaces, Unicode names, empty files, multiple
  hunks, and missing final newlines.
- Keep verdict thresholds separate from reporting severity.

Walkz should not copy reviewdog's option to accept a shell diff command. Git commands
will remain fixed argument arrays. Reporter abstractions also wait for the hosted
milestone.

## PR-Agent: separate trusted settings from repository settings

We inspected <https://github.com/The-PR-Agent/pr-agent> at
`97169bcab8943d457b99256d357b856c68e0c61e`.

- Allowlist the repository settings that may affect host behavior. Paths, output sinks,
  and prompt templates must remain host-controlled.
- Read guidance from a trusted default or base branch.
- Render old and new hunks explicitly, with new-side line numbers for model grounding.
- Calculate prompt cost before selecting and packing patches.

Walkz will order context by change risk, not patch size. It will also fail closed when
token counting or patch parsing fails. PR-Agent sometimes returns zero or empty content
after those errors, which would hide incomplete coverage in Walkz. Its provider and
hosting breadth is outside Milestone 1.

## Danger JS: keep the CLI thin

We inspected <https://github.com/danger/danger-js> at
`ffde83de95e46ca9948efff7ae47d3d84073bc98`.

- Keep command parsing, execution, result transformation, and platform publishing at
  separate boundaries.
- Test transformations of empty, single, and multiple findings independently from the
  command entry point.
- Test CLI paths containing spaces.

Walkz will use Node's native argument parser instead of Commander. It will not split a
subprocess command string on spaces, load executable rule files, or add a matrix of CI
providers during the local milestone.

## Execa: process termination needs an operating-system design

We inspected <https://github.com/sindresorhus/execa> at
`8017b279e19347efaf2587711c2d57dbd4330740`.

- Validate timeouts as finite, non-negative numbers.
- On Unix, start the child in its own process group and signal the negative process ID.
- On Windows, call the absolute `taskkill.exe` path with an argument array and `/T /F`.
- Fall back to the direct child when tree termination is unavailable, but expose that
  reduced guarantee to the caller.

Windows `.cmd` resolution and quoting need a focused spike before the runner contract is
fixed. We will not add Execa automatically. First we will prove whether the required
behavior can be implemented safely with Node's standard library.

## lint-staged: parse Git output without guessing filenames

We inspected <https://github.com/lint-staged/lint-staged> at
`dcb59f6334275ed80b130d963c79296046ee8116`.

- Request NUL-delimited Git output and parse rename destinations explicitly.
- Disable recursive submodule behavior in Git commands.
- Test non-ASCII names, shell metacharacters, symlinks, submodules, worktrees, merge
  conflicts, and partially staged files.
- Resolve paths before comparing them with the repository root.

Walkz must report skipped symlinks and submodules rather than silently dropping them.
Git failures must become typed errors instead of `null`. We will not adopt lint-staged's
stash and restore workflow because a Walkz review must not mutate the target repository.

## Inori: strict parsing matters more than tolerant output

We inspected <https://github.com/VOD-Studio/inori> at
`23ec870451c96a65d0a48c9830579668aede6962`.

- Track the set of added line numbers for each changed path.
- Cut oversized context at file boundaries and report which files were omitted.
- Test multiple hunks, deleted lines, invalid locations, truncated output, and provider
  response type drift.

Walkz will reject malformed provider output instead of publishing it as a summary. It
will not salvage arbitrary text around JSON, downgrade an invented location into a
general comment, or silently ignore lockfiles and generated files. Those cases affect
coverage and may require stricter handling.

## Decisions carried into Walkz

- Keep the CLI entry point thin and the engine independent from terminal output.
- Use NUL-delimited Git output and a normalized changed-line index.
- Validate configuration, provider output, and stored result shapes with Zod.
- Store commands as executable and argument arrays. Never evaluate repository strings
  through a shell.
- Make missing context, parsing failures, and uncertain process cleanup visible. They
  cannot produce `SHIP`.
- Build our own small vertical slice. Do not import a reference project's provider,
  plugin, or hosting architecture.

Six repositories answer the current questions, but there is no fixed ceiling. When a
new question appears, search broadly and inspect as many relevant sources as needed.
Clone a repository when local source search would help, then record its exact commit
and useful decisions here.
