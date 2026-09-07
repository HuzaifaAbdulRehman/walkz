# Walkz

**AI-powered pull request co-pilot.**

Walkz reviews diffs, runs repository checks, and uses evidence instead of
model confidence to decide whether a change is ready to ship.

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

## Verify the project

```powershell
npm run verify
```

The current release is the local reviewer. Counterfactual base/head proof,
GitHub integration, hosted workers, a dashboard, and fix generation are not
implemented yet.
