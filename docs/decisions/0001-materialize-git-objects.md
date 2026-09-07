# Materialize proof workspaces from Git objects

Status: Accepted
Date: 2026-09-07

## Context

A proof must run against the exact base and head commits without changing the
developer's working tree. Checkout operations can apply Git attribute conversions
and smudge filters, while linked worktrees add Git metadata that must be protected
and removed. Git documents these checkout effects in its
[attributes reference](https://git-scm.com/docs/gitattributes).

## Decision

Walkz enumerates each commit with NUL-delimited `git ls-tree` output and reads its
regular blobs through bounded `git cat-file --batch` input. Git documents the batch
protocol in the [cat-file reference](https://git-scm.com/docs/git-cat-file).

The materializer accepts canonical commit hashes, rejects links, submodules, special
files, unsafe paths, and cross-platform path collisions, then writes raw blob bytes
to fresh temporary base and head directories. File counts, total bytes, Git input,
Git output, and command time are limited. The temporary root contains no `.git`
metadata and is removed after success, failure, or cancellation.

## Options considered

- Git checkout or linked worktrees were rejected because filters can transform
  files and the extra Git metadata widens the cleanup boundary.
- Git archive extraction was rejected because it adds an archive parser and another
  path-containment boundary.
- One `cat-file` process per blob was rejected because process startup scales with
  repository size.

## Consequences

Proof inputs retain the exact committed bytes, including binary content, and the
developer's dirty tree remains untouched. Repositories containing links, submodules,
special files, unsafe names, or paths that collide on supported platforms cannot use
this proof path yet. Later orchestration must report that gap as incomplete coverage.

This decision prepares files only. Locked container execution, dependency
preparation, and evidence classification remain separate phases.
