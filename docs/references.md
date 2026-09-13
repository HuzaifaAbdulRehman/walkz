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

## jsdiff: parse Git patches behind a narrow wrapper

We inspected <https://github.com/kpdecker/jsdiff> at
`87c5152b9b3908d8364e875aabce8f4015c7fe0e`.

- Version 9 parses Git extended headers, renames, copies, modes, binary markers,
  C-quoted paths, and UTF-8 octal escapes.
- Its hunk parser rejects mismatched line counts and invalid hunk lines.
- The `diff` package has no runtime dependencies and supports ESM and CommonJS.
- Walkz still owns input caps, path normalization and containment, added-line
  indexing, binary handling, and coverage reporting.

Adopt only `parsePatch` behind the Git adapter. This keeps the exit cost low and
lets Walkz reject parser output that violates its stricter repository rules.

## Execa: use maintained process-tree handling

We inspected <https://github.com/sindresorhus/execa> at
`8017b279e19347efaf2587711c2d57dbd4330740`.

- Version 10 accepts argument arrays with `shell: false` and resolves Windows command
  shims without string interpolation.
- `killDescendants` uses a Unix process group and an absolute, validated
  `taskkill.exe` path on Windows.
- Descendant termination remains best-effort. An escaped Unix daemon or failed Windows
  fallback may survive.
- The package adds twelve runtime dependencies, so Walkz will keep it behind
  `executeCommand` and `terminateProcessTree`.

The new version changes the earlier standard-library-first decision. Walkz will use
Execa for Milestone 1, but it will still test child and grandchild cleanup directly and
will never describe the local runner as a sandbox.

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

## ReviewGate: compare deterministic policy boundaries

We inspected <https://github.com/LVTD-LLC/reviewgate> at
`87aa4396de6d670edba731ca8215e139f03cf167`.

- Keep model confidence separate from deterministic blocking disposition.
- Bind a result to an exact head commit.
- Treat provider and parse failures as inconclusive.
- Keep forked content, repository instructions, and model text outside authority.

ReviewGate is a useful comparator, but it is new, written in Rust, and deliberately
does not execute PR code. Walkz will not adopt it. Its policy split supports the
existing design, while base/head execution remains Walkz's differentiator.

## Groq: verify capabilities before sending code

We checked Groq's official documentation on 7 September 2026.

- The [models endpoint](https://console.groq.com/docs/models) reports which models are
  active. Setup should query it instead of assuming a model ID still exists.
- [Strict structured outputs](https://console.groq.com/docs/structured-outputs) require
  every field and reject extra properties. The documented model list is an allowlist
  that must be checked again when provider sources are refreshed.
- Groq documents distinct [API errors](https://console.groq.com/docs/errors) for bad
  credentials, forbidden access, rate limits, invalid requests, and server failures.
  [Rate-limit headers](https://console.groq.com/docs/rate-limits) include `Retry-After`
  on `429` responses.
- Groq says inference inputs and outputs are not retained by default, but temporary
  logging may apply. Its [data controls](https://console.groq.com/docs/your-data) explain
  retention settings and Zero Data Retention.

Walkz discovers models without sending repository content. A review uses native
`fetch`, a bounded response body, one cancellation deadline, and one retry layer. It
accepts only a clean strict-schema completion from the requested model. The CLI must
show the privacy notice before private code is sent; that wiring belongs to the CLI
phase.

## Decisions carried into Walkz

- Keep the CLI entry point thin and the engine independent from terminal output.
- Parse bounded patches with `diff`, then build a normalized changed-line index.
- Use NUL-delimited Git output for machine-readable file and rename records.
- Use Execa behind the runner boundary with `shell: false` and best-effort descendant
  termination.
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

## GitHub patch delivery: keep permission paths separate

We checked GitHub's official documentation on 11 September 2026.

- [Pull request review comments](https://docs.github.com/en/rest/pulls/comments)
  require pull-request write permission. Comments should use `line`, `side`, and the
  exact `commit_id`; the older diff `position` field is closing down.
- [Suggested changes](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request)
  are review comments that the pull-request author may apply. Walkz can publish this
  option without contents-write permission.
- [Git references](https://docs.github.com/en/rest/git/refs) and
  [repository contents](https://docs.github.com/en/rest/repos/contents) require
  contents-write permission. GitHub also requires workflows-write permission when an
  app changes files under `.github/workflows`.

Walkz will represent suggestions and fix branches as different delivery modes. An
approval is bound to the proposal hash and reviewed head SHA. A later head makes the
proposal stale without erasing who approved it. Raw patch text stays ephemeral; the
database keeps hashes, decision metadata, and GitHub references only. We did not clone
a reference repository because GitHub's endpoint contracts answered this question
directly.

## Groq patch generation: verify more than the schema

We applied the Groq structured-output guidance checked on 7 September 2026 to the
approved fix loop.

- The provider requires every patch field and rejects extra properties, but Walkz still
  validates identifiers, paths, ranges, sizes, token accounting, and approval after the
  response arrives.
- The model receives a bounded window from the exact head file. Invisible formatting
  controls are exposed, repository text remains untrusted, and the request grants no
  tools or write access.
- A candidate contains one same-file replacement that overlaps the verified finding.
  Its hash covers the finding, revisions, original-content hash, replacement, delivery
  mode, and approval requirement.
- The candidate stays in memory. The persistence boundary accepts only its identifiers,
  revisions, delivery mode, and hash.

Patch requests use the provider's existing timeout and retry layer. Walkz does not add
another retry around it. No extra reference repository was needed because the existing
Groq and GitHub endpoint research covered the provider and delivery boundaries.

GitHub does not expose an idempotency key for review-comment creation. Walkz holds a
short PostgreSQL lease while it calls GitHub and tags each suggestion with a
deterministic marker. A retry scans a bounded comment history for the exact body,
commit, location, and marker. Conflicting reuse fails closed. If the head moves during
a new publish, Walkz deletes only the comment it just created. An expired lease lets a
new request recover after the process dies.

## Groq patch replay: reduce sampling drift

We checked Groq's official [API reference](https://console.groq.com/docs/api-reference)
and [prompting guide](https://console.groq.com/docs/prompting) on 12 September 2026.

- The chat completion endpoint accepts an integer seed. Groq describes repeated output
  as best effort, not guaranteed, and recommends checking the backend fingerprint when
  reproducibility matters.
- Lower temperature makes sampling more deterministic. Groq recommends combining a
  seed with a temperature between 0 and 0.3 when consistent output is useful.

Walkz now derives a stable, non-secret seed from the complete patch request and uses a
temperature of zero. This makes the approval-time replay more likely to match the text
the user reviewed. The patch hash remains the authority: if replay returns different
text, Walkz refuses to publish it.

## Docker Compose proof workspaces

We checked Docker's official [volume guide](https://docs.docker.com/engine/storage/volumes/)
and [`docker run` reference](https://docs.docker.com/reference/cli/docker/container/run)
on 12 September 2026.

- A named volume can be shared by the worker and a child proof container. The
  `volume-subpath` option limits the child mount to an existing directory inside that
  volume, and `readonly` prevents writes to the checkout.
- Docker warns that access to its API socket grants control of the daemon. Mounting the
  socket into the worker is suitable for this local Compose stack, not a production
  trust boundary.

The local worker writes temporary checkouts under one dedicated volume. Each proof
container sees only its checkout subdirectory, read-only, and never receives the Docker
socket, GitHub token, database credentials, or network access. A production deployment
should move this executor behind a separate, credential-free service.

## GitHub comment commands: check current repository access

We checked GitHub's official documentation on 12 September 2026.

- The [`issue_comment` webhook](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment)
  requires Issues read permission and covers comments on both issues and pull
  requests. Walkz must also check that the payload belongs to a pull request.
- [Creating a comment](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment)
  accepts either Issues write or Pull requests write permission. The latter is
  already required for approved suggestions, so command replies need no broader
  repository permission.
- [Repository permission lookup](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user)
  works with an installation token and Metadata read permission. Walkz will use
  the current calculated permission instead of trusting `author_association` from
  the comment payload.

The command boundary accepts only an exact `@walkz-review review` or
`@walkz-review propose fix` comment from a human user. It returns bounded identity
and repository metadata and discards the raw body. Durable intake, authorization,
and idempotent replies remain separate steps.

## Versioned repository policy packs

We checked GitHub's [CodeQL pack reference](https://docs.github.com/en/code-security/reference/code-scanning/codeql/codeql-cli/codeql-query-packs)
and OPA's [bundle documentation](https://www.openpolicyagent.org/docs/management-bundles)
on 13 September 2026. Both attach a stable name and revision to the policy being
run. OPA also keeps the previously active bundle when a replacement fails
verification.

Walkz records exact built-in pack IDs such as `security-core@1`, `supply-chain@1`,
and `delivery-safety@1` in new repository configurations. The registry accepts
only built-in packs. Packs cannot download code, define commands, or grant model
tools. Older configurations retain their existing hash and resolve to the same
versioned defaults. An explicit empty list stays empty.

## MCP capability boundary

We checked the MCP [tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools),
[authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
and the official TypeScript SDK at commit
[`b654261`](https://github.com/modelcontextprotocol/typescript-sdk/commit/b65426158ed9f29aea8ef3dc09ca22d7d9d6f970)
on 13 September 2026. The SDK snapshot is version 2.0.0 and supports the
2026-07-28 protocol revision.

Walkz uses the SDK's schema validation and tool annotations, but annotations are
descriptive rather than an authorization control. Trusted server code injects a
short-lived grant with one subject, repository, audience, capability list, and
per-tool call limits. Tool arguments cannot replace those values. Responses
must match the requested record and head revision. The fix tool can prepare a
hashed proposal, but approval, publication, pushing, and merging remain outside
its authority.
