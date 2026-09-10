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

## Use Walkz locally

The local CLI is the usable path today. A normal review looks like this:

1. Create or check out a branch in the repository you want to review.
2. Initialize Walkz once and let it inspect the repository commands.
3. Run `doctor` to catch missing Git, Node, configuration, or provider setup.
4. Run `review` before opening a pull request, or use `--staged` for work that is not committed yet.
5. Read the checks, changed-line findings, coverage notes, and final verdict.
6. Fix the branch, run the review again, and open the pull request when the result is ready.

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

Useful command examples:

```powershell
# Review committed changes against the merge base
node ..\Walkz\apps\cli\dist\bin.js review

# Review only what is staged
node ..\Walkz\apps\cli\dist\bin.js review --staged

# Run repository checks without a model call
node ..\Walkz\apps\cli\dist\bin.js review --no-model

# Save a machine-readable result for CI or another tool
node ..\Walkz\apps\cli\dist\bin.js review --json
```

The process exits with `0` for `SHIP`, `1` for `FIX`, `2` for `HUMAN` or
`INCONCLUSIVE`, and `3` for configuration or infrastructure errors. A `FIX`
result means the configured evidence policy found something that needs attention;
it does not apply a patch automatically.

## Planned GitHub workflow

The hosted GitHub App is still in development. When that milestone is complete,
the intended developer flow will be:

1. Sign in with GitHub and install Walkz on selected repositories.
2. Open a pull request or mark a draft pull request ready for review.
3. Walkz creates a pending `Walkz / review` check. Every-push reviews remain an explicit repository setting.
4. Walkz runs repository checks, reviews bounded changed-file context, and publishes one summary with bounded annotations.
5. Open the check to see the verdict, evidence level, exact base/head commits, and any incomplete coverage.
6. If a fix is proposed later, approve it explicitly. Walkz will re-run the proof and regression checks before the branch is considered ready.

There is no required comment tag in the current CLI. The GitHub trigger and
dashboard commands will be documented here when they are implemented.

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

## Run the hosted stack locally

The hosted services can run together with Docker Desktop. This is for local
development, not a public deployment. PostgreSQL and Redis stay inside the
Compose network. The dashboard listens on port 3000, while port 3001 exposes
the API readiness check on localhost.

```powershell
npm run hosted:init -- --public-url https://your-public-origin
# Add the GitHub App ID, client values, and base64 private key to infra\.env.
docker compose --env-file infra/.env -f infra/compose.yml up --build
```

The setup command generates the local secrets and refuses to replace an existing
`infra/.env` file. Keep that file on your machine.

Open `http://localhost:3000` after the health checks pass. The API readiness
endpoint is `http://localhost:3001/health/ready`.

For a real GitHub callback or webhook, use one public HTTPS address that reaches
the dashboard on port 3000. The dashboard forwards allowlisted hosted routes to
the private API service. Set the OAuth callback to `/auth/github/callback` and
the webhook endpoint to `/webhooks/github`. The application needs metadata
read, contents read, pull-request read, checks read/write, and issues read. It
does not need contents-write permission for this milestone.

The dashboard needs an authenticated session and a repository ID before it can
show review history. The current setup proves that the hosted services start
together; a real pull-request check remains the final Milestone 4 check.

## Verify the project

```powershell
npm run verify
```

## Roadmap

Milestones 1 through 3 are complete. Milestone 4 is in progress and covers the
live GitHub App, check publishing, configuration, review history, and dashboard.
Milestone 5 adds approved fix branches and reproof. Milestone 6 adds deeper
reliability, specialist review passes, evaluation, and more languages.
