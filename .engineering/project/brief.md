# Project brief

Status: researched
Owner: Huzaifa Abdul Rehman
Decision date: 2026-09-07

## Project profile

Walkz is a high-risk developer tool delivered first as a local CLI. Milestone 1 uses
Node.js 24+, TypeScript, npm workspaces, Git, Groq, Zod, Vitest, `diff`, and Execa.
The triggered overlays cover private source, secrets, external dependencies, and
AI-assisted implementation.

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

Milestone 1 is one complete local review path. It includes `walkz init`, `doctor`,
branch and staged review, approved deterministic commands, bounded Git context, one Groq
review, changed-line validation, terminal and JSON reports, and deterministic exit codes.
A mock provider and temporary fixture repositories make the path reproducible.

## Non-goals

This milestone excludes counterfactual proof, PostgreSQL, Redis, Docker proof execution,
GitHub integration, a dashboard, automatic fixes, and multi-model arbitration. It will
not claim superiority over existing reviewers.

## Constraints

Use free-first Groq access with no paid fallback and a zero spending cap. Private code
leaves the machine only after a dated disclosure; `--no-model` must remain useful.
Repository commands require trusted configuration or explicit approval. The local runner
is not a sandbox and retains the developer's filesystem and network authority. No
deadline was supplied, so progress is gated by evidence rather than calendar dates.

## Risks and assumptions

The largest costs are credential exposure or arbitrary execution, a false `SHIP` after
missing evidence, and descendants surviving a timeout. Those risks can be reduced, but
not removed in Milestone 1.

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

Create the npm workspace, the minimum command contracts, and the safe runner boundary.
Pass literal arguments with `shell: false`, strip provider credentials from child
environments, cap and redact output, and terminate descendants on timeout or cancellation.
The slice passes when its package build and tests succeed on Windows, with the Linux
process-tree test ready for CI.

## Delivery path

1. Build and verify the runtime foundation and safe runner.
2. Add configuration, shared contracts, `init`, and `doctor`.
3. Add bounded Git collection, changed-line indexing, and risk ranking.
4. Add the Groq and mock providers with explicit failure classes.
5. Add the review pipeline, finding validation, and verdict table.
6. Integrate every CLI mode, fixture, clean-clone check, and 60-second demo.

Each phase receives a focused playbook review after the code exists. A phase ends only
when its checks pass and its commits describe observable behavior.

## Lifecycle gates

The next gate is the runner slice. Huzaifa owns every gate.

- Ready, during: after the runner slice exists, require a Windows build plus
  hostile-argument, secret, output, cancellation, and descendant tests.
- Planned, release: after all Milestone 1 phases pass, require a clean `npm ci`,
  build, full test matrix, CLI fixtures, and the 60-second demo.
- Planned, outcome: after Milestone 2 and 10 to 20 real diffs exist, compare Walkz
  with CodeRabbit or a composed baseline on precision, recall, latency, and decision
  usefulness.
