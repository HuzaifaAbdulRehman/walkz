# Single-host production Compose

The production file runs prebuilt images from one verified release. It never
builds application code on the host. Start by creating the release manifest:

```console
npm run release:verify
```

Copy `infra/.env.production.example` to `infra/.env.production`. Set each
application image to its `digest` from `artifacts/release-manifest.json`. A
registry deployment may use the equivalent `repository@sha256:digest`
reference. Fill the remaining values locally, then validate the rendered model
without printing it:

```console
npm run production:verify -- --env-file infra/.env.production
```

Do not paste `docker compose config` output into an issue or chat. The rendered
model contains the configured secrets.

After validation, start the stack with:

```console
docker compose --env-file infra/.env.production --file infra/compose.production.yml up --detach --wait --wait-timeout 180
```

Exit code `0` means the migration finished and the API and web health checks
passed. If validation fails, leave the stack stopped and correct the named
setting in the local environment file.

Only the web service publishes a host port. The default is
`127.0.0.1:3000`, intended for a host-level HTTPS reverse proxy. PostgreSQL and
Redis stay on an internal network, and PostgreSQL data uses the named
`walkz-postgres-data` volume by default. Stop the services without deleting
that volume:

```console
docker compose --env-file infra/.env.production --file infra/compose.production.yml down
```

The worker still needs the Docker socket to create isolated proof containers.
That socket grants control of the host Docker daemon, so only a trusted Walkz
worker image may receive it. A separate proof executor is required before this
layout can serve mutually untrusted tenants.
