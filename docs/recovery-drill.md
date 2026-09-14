# Recovery drill

This drill checks that a Walkz single-host release can restore PostgreSQL,
rebuild disposable BullMQ state, move to a newer application revision, and
roll back to an exact older revision. It uses synthetic records in a separate
Compose project. It does not touch the normal Walkz volumes.

## Safety boundary

The script creates a project named `walkz-recovery-<random suffix>`, two named
volumes scoped to that project, and a temporary PostgreSQL dump. It refuses a
dirty release manifest, matching release revisions, missing immutable image IDs,
or mismatched image labels. The dump is capped at 64 MiB and is deleted after
normal success or a handled failure. The final check fails if a drill
container, network, or volume remains.

The dump may contain private operational data, even though Walkz does not store
source files or raw model traffic. Treat a real backup as confidential. This
drill does not retain one.

## Run it

Docker Desktop must be running. Keep the manifest for the currently deployed
release before building the candidate:

```powershell
Copy-Item artifacts/release-manifest.json artifacts/release-manifest.baseline.json
npm run release:verify
npm run production:recovery -- --baseline-manifest artifacts/release-manifest.baseline.json --env-file infra/.env.production
```

The environment file stays local. The script gets application image IDs from
the two manifests and uses Docker group `0` by default, which matches Docker
Desktop. A Linux host can pass the socket group explicitly:

```console
npm run production:recovery -- --baseline-manifest artifacts/release-manifest.baseline.json --docker-gid 123 --env-file infra/.env.production
```

The command exits nonzero if any step fails. It prints the random project name
before starting so an interrupted run can be identified. Expect about two
minutes on a warm Docker Desktop install; allow ten minutes before treating it
as stuck. Stop immediately if the printed name does not start with
`walkz-recovery-`. Do not use a production database for this exercise.

## What a pass proves

The drill performs these checks in order:

1. Start the baseline PostgreSQL and Redis images and apply migrations.
2. Insert one known queued review and create a compressed logical dump.
3. Remove the baseline stack and its volumes.
4. Restore into a fresh PostgreSQL volume and apply candidate migrations.
5. Rebuild the missing BullMQ review job from durable PostgreSQL state.
6. Cancel the synthetic job before starting the candidate API and worker.
7. Verify the candidate image labels, run the older migration command, and
   recreate API and worker from the baseline image IDs.
8. Read the restored record again, remove the stack, delete the dump, and
   verify that no drill resources remain.

`artifacts/recovery-drill.json` records revision IDs, migration counts, elapsed
time, dump size and hash, and the restored synthetic record ID. It contains no
dump bytes or credentials and is ignored by Git.

The rehearsal on 14 September 2026 restored one 78,929-byte dump across 21
migrations, recovered one queued review, and rolled back API and worker in
93,387 ms. The final resource check found no matching containers, networks, or
volumes.

## When real data exists

Create backups only after a deployment holds data worth recovering. Store them
off the Docker host, encrypt them, limit access, and set retention from an
agreed recovery-point objective. A scheduled dump is not enough. Restore a
selected recovery point into an isolated target and reconcile the records
before calling it usable.

Walkz does not choose backup storage, scheduling, encryption keys, or
point-in-time recovery in this phase. Those depend on the hosting decision and
need separate approval before real users rely on the service.

Run the drill before each beta release that changes migrations, queue recovery,
or the production Compose contract. Also run it after restoring Docker data or
moving the service to another host. The maintainer owns the decision to stop a
release when the drill fails.
