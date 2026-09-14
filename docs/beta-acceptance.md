# Beta acceptance

This drill runs the complete Walkz beta journey from fresh PostgreSQL and Redis
state. It then restarts disposable queue infrastructure, reconciles durable work,
and rolls the application back to an exact baseline release. The drill keeps the
normal Walkz Compose project and volumes untouched.

## Safety boundary

The script creates a random `walkz-beta-<suffix>` Compose project, two matching
named volumes, and a temporary Compose bundle under the operating system's temp
directory. The bundle contains manifests and Compose configuration, not the
environment file or its secrets. The state and result files under `artifacts/`
contain operational metadata only and are ignored by Git.

The script refuses dirty manifests, matching releases, mutable application image
references, altered temporary Compose files, unsafe paths, and unexpected Docker
resource names. A failed manual checkpoint leaves the isolated stack running so
the journey can continue. Successful completion removes the stack, volumes,
network, temporary bundle, and state file.

## Prepare the releases

Docker Desktop must be running. Preserve the current release before building the
candidate from a clean commit:

```powershell
Copy-Item artifacts/release-manifest.json artifacts/release-manifest.baseline.json
npm run release:verify
```

Use a temporary HTTPS origin that forwards to the local web port. Set the GitHub
App callback to `<origin>/auth/github/callback` and its webhook URL to
`<origin>/webhooks/github`.

## Start the clean stack

```powershell
npm run production:acceptance -- --action start `
  --baseline-manifest artifacts/release-manifest.baseline.json `
  --env-file infra/.env.production `
  --public-url https://walkz.example.com
```

The command starts only exact image IDs from the two manifests. It applies
migrations, checks the candidate revision labels, confirms the dashboard, and
confirms that GitHub OAuth begins at the configured public origin.

Complete these actions in the isolated stack:

1. Sign in with GitHub and connect the selected repository.
2. Add the repository's Groq key.
3. Run a review that produces a `FIX` verdict with `VERIFIED` evidence.
4. Approve and publish the GitHub suggestion.
5. Apply the suggestion and let Walkz re-prove the change.

## Finish the drill

```powershell
npm run production:acceptance -- --action finish
```

The command first verifies that the manual journey created durable records after
the clean stack started. It removes and recreates Redis, reconciles work from
PostgreSQL, and checks that GitHub side-effect counts and hashes do not change.
It then recreates the application from the baseline image IDs, runs the older
migration command, and checks the same durable journey again. A pass writes a
sanitized `artifacts/beta-acceptance.json` report only after cleanup succeeds.

## Recover from an interruption

If the laptop or terminal stops after `start`, rerun `finish`. The ignored state
file identifies the exact Compose project, manifests, and temporary bundle. If
the real journey is incomplete, the command stops without deleting it.

To abandon the drill and delete only its project-scoped resources:

```powershell
npm run production:acceptance -- --action cleanup
```

Do not edit the temporary Compose bundle. Cleanup intentionally refuses a bundle
whose hash no longer matches the state file.

## What a pass proves

A pass proves that one real GitHub journey survives a disposable queue restart,
does not repeat recorded GitHub side effects during reconciliation, and remains
readable after rollback to the exact baseline images. It also proves that the
isolated Docker resources can be removed completely.

The drill does not select a hosting provider, publish images, retain a production
backup, test multi-host failover, or prove demand from real users.
