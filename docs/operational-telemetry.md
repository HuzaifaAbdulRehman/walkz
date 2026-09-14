# Operational telemetry

Walkz exposes small JSON snapshots for local operation. The development stack
binds the API endpoint to `127.0.0.1:3001` and the worker endpoint to
`127.0.0.1:3002`:

```powershell
Invoke-RestMethod http://127.0.0.1:3001/ops/telemetry
Invoke-RestMethod http://127.0.0.1:3002/ops/telemetry
```

Both services also provide `/health/live` and `/health/ready`. Liveness only
shows that the process can answer HTTP. Readiness returns `503` when a required
dependency is unavailable.

The API snapshot reports fixed HTTP status classes, request latency, PostgreSQL
health, review statuses and verdicts from the last 24 hours, and the pending
outbox count and age. The worker adds Redis health, current BullMQ counts for
the four fixed queues, queue delay, processing duration, job failures, worker
errors, and recovery outcomes.

Process counters reset when a service restarts. Review and outbox aggregates
come from PostgreSQL and survive a restart. The database query has a one-second
statement timeout and uses a 24-hour window.

The production Compose file does not publish ports 3001 or 3002. Fetch the
snapshots from inside their containers when diagnosing a single-host install:

```console
docker compose --env-file infra/.env.production --file infra/compose.production.yml exec --no-TTY api node --input-type=module --eval "console.log(await (await fetch('http://127.0.0.1:3001/ops/telemetry')).text())"
docker compose --env-file infra/.env.production --file infra/compose.production.yml exec --no-TTY worker node --input-type=module --eval "console.log(await (await fetch('http://127.0.0.1:3002/ops/telemetry')).text())"
```

Telemetry never includes repository IDs, pull-request numbers, file paths, job
IDs, source text, prompts, model responses, credentials, or raw error messages.
Queue and outcome names come from closed sets. This keeps label cardinality
bounded and makes the output safe to retain as operational evidence.

Worker logs use one JSON object per line. They contain only a timestamp, level,
service, event name, and the fixed queue or dependency when relevant. A failed
job records its attempt number but not its ID or error text.
