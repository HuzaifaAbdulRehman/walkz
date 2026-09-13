# Release artifact contract

Walkz builds the API, web, and worker images from one Git commit. Run:

```console
npm run release:verify
```

The command refuses a dirty tree, uses the commit timestamp as
`SOURCE_DATE_EPOCH`, and writes `artifacts/release-manifest.json`. Each manifest
entry records the local image's content-addressed image ID, target, platform,
and configured user. Registry digests will replace local image IDs when registry
publishing is added.

Every image must carry the same version, source URL, and full revision in OCI
labels. The final process identity is `1000:1000`. Verification also rejects
credential-shaped environment or history entries and `.env`, `.npmrc`, private
key, or credential files under `/workspace`.

Promote one built artifact set between environments. Do not rebuild the same
commit for each environment. Next.js creates fresh encryption material during a
build, so an independent rebuild can have a different digest even when its
source revision and build ID match. The manifest identifies the exact images
that passed verification.

`--allow-dirty` exists for development only. Its manifest records
`"sourceTree": "dirty"` and is not a release artifact.
