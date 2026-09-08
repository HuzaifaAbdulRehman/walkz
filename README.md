# Walkz

**AI-powered pull request co-pilot.**

Walkz reviews diffs, runs repository checks, and uses evidence instead of
model confidence to decide whether a change is ready to ship.

The rule is simple: models choose what to investigate; evidence decides what to
trust. A finding becomes blocking only when the same reproducer passes on the
base commit and fails on the pull-request head.

![Walkz finding a supported regression](docs/walkz-demo.svg)

## Try the local demo

You need Node.js 24 or newer, npm 11, and Git.

```powershell
npm ci
npm run demo
```

The demo builds a disposable Git repository, introduces a boundary regression,
and returns `FIX` only after a failed check points to the changed line. It uses
the built-in mock provider, so it needs no API key or network access.

## Review a repository

Walkz is currently run from source. This example assumes the Walkz checkout and
the target repository share a parent directory:

```powershell
npm ci
npm run build
cd ..\target-repository
node ..\Walkz\apps\cli\dist\bin.js init
$env:GROQ_API_KEY = "your-key"
node ..\Walkz\apps\cli\dist\bin.js doctor
node ..\Walkz\apps\cli\dist\bin.js review
```

`review` compares the current branch with its merge base. Use `--staged` for
staged changes, `--no-model` for deterministic checks only, or `--json` for
machine-readable output.

Walkz reads command authority from the trusted base revision, runs approved
commands without a shell, validates findings against changed lines, and reports
incomplete coverage. Provider-backed review sends bounded context to Groq only
after the repository checks run.

## What is implemented

- Local CLI review with deterministic checks, mock and Groq providers, changed-line validation, and `SHIP`, `FIX`, `HUMAN`, `INCONCLUSIVE`, and `ERROR` verdicts.
- Counterfactual proof that runs a bounded reproducer against exact base and head revisions.
- Hosted PostgreSQL state, Redis and BullMQ workers, transactional outbox delivery, leases, restart recovery, encrypted provider credentials, audit retention, cancellation, and stale-run supersession.
- GitHub integration foundations: signed OAuth sessions, read-only installation discovery, explicit review triggers, exact-SHA check payloads, authenticated configuration history, and review-history routes.

The hosted GitHub App and dashboard are still being built. The current code does
not claim a deployed App, a live production check, automatic fixes, or automatic
merges.

## Verify the project

```powershell
npm run verify
```

## Roadmap

Milestones 1 through 3 are complete. Milestone 4 is in progress and covers the
live GitHub App, check publishing, configuration, review history, and dashboard.
Milestone 5 adds approved fix branches and reproof. Milestone 6 adds deeper
reliability, specialist review passes, evaluation, and more languages.
