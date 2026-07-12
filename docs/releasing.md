# Releasing ccm

This runbook describes the local verification foundation. npm trusted publishing and the GitHub
release workflow are intentionally not enabled until the repository and npm environment are
configured and a pack-once release has been proven end to end.

## Runtime and version contract

- Use Bun 1.3.14, the version pinned in `packageManager` and CI.
- Release tags are `vX.Y.Z`; `package.json`, CLI `--version`, and the changelog section use `X.Y.Z`.
- The release commit must be on `main`.
- npm is the installation channel. The installed CLI still runs with Bun.

## Prepare

1. Update `package.json` to the release version and refresh `bun.lock` with Bun 1.3.14.
2. Replace the changelog's Unreleased content with a dated `## [X.Y.Z] - YYYY-MM-DD` section and
   restore an empty Unreleased section above it.
3. Run `bun install --frozen-lockfile` and `bun run check`.
4. Commit the release preparation, merge it to `main`, and create the matching annotated tag.

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

Do not repack between verification and publication. When automated publishing is added, it must
publish and attach this same tarball and make reruns safe after npm publication succeeds.

## Current handoff boundary

Publishing remains manual. Before adding a release workflow, configure npm trusted publishing and
the GitHub `npm` environment, then implement provenance, registry verification, checksums,
attestation, and idempotent GitHub release creation as one reviewed slice.
