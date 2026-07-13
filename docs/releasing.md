# Releasing ccm

Releases are published by `.github/workflows/release.yml` from an exact `vX.Y.Z` tag through npm
trusted publishing. The workflow packs once, verifies and smokes that tarball, reconciles npm by
both `dist.integrity` and `dist.shasum`, and attaches the same artifact to the GitHub release.

## Runtime and version contract

- Use Bun 1.3.14, the version pinned in `packageManager` and CI.
- Release tags are `vX.Y.Z`; `package.json`, CLI `--version`, and the changelog section use `X.Y.Z`.
- The release commit must be on `main`.
- npm is the installation channel. The installed CLI still runs with Bun.

## Prepare

1. Update `package.json` to the release version and refresh `bun.lock` with Bun 1.3.14.
2. Replace the changelog's Unreleased content with a dated `## [X.Y.Z] - YYYY-MM-DD` section and
   restore an empty Unreleased section above it.
3. Run `bun install --frozen-lockfile`, `bun audit`, and `bun run check`.
4. Commit the release preparation and merge it to `main`.
5. Create and push the matching annotated tag. Pushing the tag starts the release workflow.

## Verify one artifact

Fetch `main` and tags, then pack exactly once:

```bash
mkdir -p .release
tarball=$(npm pack --pack-destination .release --silent)
bun scripts/verify-release.ts --tag "v$(bun -p 'import p from "./package.json"; p.version')" \
  --main-ref origin/main --tarball ".release/$tarball"
bun scripts/smoke-package.ts ".release/$tarball"
```

The verifier checks tag/package/CLI/changelog agreement, confirms the tag commit is on the selected
main ref, and requires the tarball to contain exactly the allowlisted package surface. The smoke
script installs that exact tarball with npm under an isolated HOME and confirms both `ccm
--version` and `ccm --help`.

Do not publish locally or repack after verification. The workflow publishes the exact tarball,
waits for the registry's SHA-512 `dist.integrity` and SHA-1 `dist.shasum` to match, installs the
immutable registry version under an isolated HOME, emits `SHA256SUMS`, creates a GitHub artifact
attestation, and creates or reconciles the GitHub release and assets.

## Trusted publisher contract

The npm package must trust this exact identity:

- GitHub owner/repository: `ardasevinc/claude-code-migrate`
- workflow filename: `release.yml`
- environment: `npm`
- allowed action: `npm publish`

The release job runs only on GitHub-hosted Ubuntu, requests `id-token: write`, and uses npm 11.17.0
on Node 24. No long-lived npm token is configured. npm trusted publishing generates npm provenance
automatically; `actions/attest` separately records the GitHub artifact attestation.

## Reruns and failure boundaries

- Before publication, any verification failure is safe: no registry or release state changed.
- If npm already has the version with both exact tarball digests, the workflow skips publication
  and continues verification. A different digest fails closed because npm versions are immutable.
- Registry verification must succeed before attestation or GitHub release creation.
- GitHub release reruns replace the notes and clobber only the two managed assets: the exact
  tarball and `SHA256SUMS`.
- Failed workflows are rerun from GitHub Actions. Never delete or move a published tag to retry.
