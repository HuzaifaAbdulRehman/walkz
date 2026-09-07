# Project brief

Status: building Milestone 2
Owner: Huzaifa Abdul Rehman
Decision date: 2026-09-07

## Project profile

Walkz is a high-risk developer tool delivered first as a local CLI. Milestone 2 adds
Docker-based proof execution to the existing Node.js 24+, TypeScript, Git, Groq, Zod,
Vitest, `diff`, and Execa stack. The triggered overlays cover private source, secrets,
external dependencies, local code execution, and AI-assisted implementation.

## Problem

AI reviewers can make convincing claims without proving that a pull request caused a
defect. Missing context, invented locations, provider failures, and command failures can
then look safer than they are. Walkz separates model suggestions from merge decisions and
makes incomplete coverage visible.

## User and outcome

A solo developer or small-team maintainer should be able to review a branch locally and
receive a deterministic verdict tied to exact commits, changed lines, repository checks,
and stated coverage.

## Evidence

CodeRabbit already covers much of the Milestone 1 CLI workflow, including local Git
scopes, diagnostics, terminal output, and JSON. Milestone 1 is therefore a foundation,
not the product's differentiator. See <https://docs.coderabbit.ai/cli/index>.

GitHub warns that AI review can miss problems, report false positives, and suggest unsafe
fixes. A 2026 field dataset also found more rejected than accepted CodeRabbit comments.
See <https://docs.github.com/en/enterprise-cloud@latest/copilot/responsible-use/agents>
and <https://arxiv.org/abs/2607.03316>.

Node, Git, and Groq documentation support the main boundaries: no shell interpolation,
no trust in arbitrary Git metadata, bounded structured output, explicit provider failure,
and a clear private-code disclosure. The full claim and source records are in
`evidence.json`.

## Scope

Milestone 2 adds counterfactual proof to the working local reviewer. One approved,
bounded reproducer runs against exact base and head revisions under the same isolated
conditions. Only base-pass and head-fail evidence may become `VERIFIED`.

## Non-goals

This milestone excludes PostgreSQL, Redis, GitHub integration, a dashboard, automatic
fixes, and multi-model arbitration. It will not claim usefulness on real pull requests
until the later 10 to 20 change comparison is complete.

## Constraints

Use free-first Groq access with no paid fallback and a zero spending cap. Private code
leaves the machine only after a dated disclosure; `--no-model` must remain useful.
Repository commands require trusted configuration or explicit approval. The local runner
is not a sandbox and retains the developer's filesystem and network authority. No
deadline was supplied, so progress is gated by evidence rather than calendar dates.

## Risks and assumptions

The largest costs are hostile proof code escaping its limits, base and head running under
different conditions, cleanup leaving private source behind, and incomplete proof being
treated as success. Docker narrows the runtime boundary but does not make the local daemon
or selected image risk-free.

The riskiest product assumption is that evidence makes a review more useful than the
same checks plus an existing assistant. Test it on 10 to 20 historical defects once
Milestone 2 can produce base/head proof. The first engineering experiment tests Execa's
shell-free command resolution and descendant cleanup on Windows and Linux.

## Success and stop conditions

The baseline is no application code and no runnable review. Milestone 1 succeeds when
every acceptance case in `AGENTS.md` passes from a clean clone and the demo completes in
60 seconds. A broken fixture may return `FIX` only when it opts into blocking
`SUPPORTED` deterministic evidence. The default still blocks only `VERIFIED` evidence.

Revisit the runner design if child processes survive or argument metacharacters reach a
shell. Narrow to a deterministic-only tool if no free Groq model meets the structured
output and budget checks. Stop product expansion if the later real-diff comparison does
not improve decision usefulness over CodeRabbit or checks plus an assistant.

## First slice

Define proof plans, execution results, resource budgets, and stable digests. A plan binds
exact revisions, a digest-pinned image, reproducer bytes, locked isolation settings, and
one command approved outside the plan. The slice passes when boundary tests, a red
authorization mutation, the full suite, and cross-platform CI succeed.

## Delivery path

1. Define proof contracts, external command approval, stable digests, and budgets.
2. Materialize exact base and head workspaces without changing the developer's tree.
3. Prepare dependencies separately and run both revisions in locked containers.
4. Classify paired outcomes and bind verified evidence to the verdict engine.
5. Add golden changes, measurements, a clean-clone check, and the short demo.

Each phase receives a focused playbook review after the code exists. A phase ends only
when its checks pass and its commits describe observable behavior.

## Lifecycle gates

The next gate is the golden proof evaluation. Huzaifa owns every gate.

- Passed, release: Milestone 1 passed a clean install, 189 tests, the local demo,
  Gitleaks, OSV, and Windows plus Ubuntu CI at `c24c993`.
- Passed, during: proof contracts and planning passed 218 tests in normal and shuffled
  order. The authorization test failed when its gate was deliberately disabled.
- Passed, during: exact base and head workspaces leave the developer's dirty tree
  unchanged, preserve committed bytes, reject unsafe links and paths, and clean up
  after success, failure, or cancellation. The full suite passed 236 tests, and the
  cleanup test failed when cleanup was deliberately disabled.
- Passed, during: exact base and head trees run with the same pinned image and command.
  The runtime has no network or host secrets, uses bounded resources, and removes its
  containers after success, failure, timeout, or cancellation. The full suite passed
  258 tests, and seven opt-in tests passed against Docker Desktop's Linux engine.
- Passed, during: matching plan, command, revision, and SHA records now bind paired
  results to findings. A base pass and head failure creates `VERIFIED` evidence. Equal,
  inverse, cancelled, timed-out, infrastructure, and forged-provenance cases stay
  non-blocking. The full shuffled suite passed 278 tests, including the real Docker
  regression proof.
- Ready, during: golden changes must measure proof catch rate, false positives, proof
  rate, latency, and provider use.
- Planned, release: Milestone 2 must produce one `VERIFIED` finding from identical
  base/head execution and pass from a clean clone on Windows and Ubuntu.
- Planned, outcome: after 10 to 20 real diffs exist, compare Walkz
  with CodeRabbit or a composed baseline on precision, recall, latency, and decision
  usefulness.
