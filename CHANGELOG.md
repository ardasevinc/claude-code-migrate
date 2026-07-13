# Changelog

Notable changes to ccm are recorded here. Releases follow semantic versioning and Git tags use
the `vX.Y.Z` form.

## [Unreleased]

- Added fail-closed configuration, SSH-target, process, archive, staging, and interrupt handling.
- Added atomic manifest-v2 archives with bounded streaming integrity verification, legacy archive
  compatibility, and archive inspection.
- Unified backup, restore, push, dry-run, and diff behavior around immutable redacted migration
  plans.
- Made local restore and remote push transactional with durable journals, explicit recovery,
  crash/signal handling, managed-state verification, and redacted execution receipts.
- Added resumable incremental rsync transport with archive fallback, sealed remote snapshots,
  transfer accounting, and one multiplexed SSH session per push.
- Added read-only health diagnostics, exact plan diffing, receipt inspection and drift
  verification, transaction listing, and explicit recovery commands.
- Added explicit target-bound host profiles with bounded assets, structured patches, plugin policy,
  and receipt provenance.
- Expanded the integration and fault-injection program across real subprocesses, transaction
  boundaries, macOS, Linux, packed npm artifacts, and fixed-seed property tests.
- Added a pack-once trusted-publishing workflow with exact registry digest reconciliation,
  immutable package smoke tests, checksums, artifact attestation, and idempotent GitHub releases.

## [1.8.2] - 2026-07-12

- Migrated configured curated Codex plugins while filtering the curated marketplace catalog.
- Preserved curated plugin revisions.

## [1.8.1] - 2026-07-12

- Cleaned temporary files when the CLI is interrupted.

## [1.8.0] - 2026-07-11

- Added cross-host Codex hook migration.
- Scoped backups to managed configuration.

## [1.7.1] - 2026-07-11

- Added npm bug-report metadata.

## [1.7.0] - 2026-07-11

- Removed unavailable ChatGPT MCP entries on target hosts.
- Validated archives before extraction and showed live archive upload progress.
- Clarified published CLI installation.

## [1.6.2] - 2026-06-29

- Suppressed warnings for unchanged Codex plugin policy.

## [1.6.1] - 2026-06-29

- Made push dry-run output more readable.

## [1.6.0] - 2026-06-29

- Added host-aware Codex plugin synchronization and dry-run policy previews.

## [1.5.1] - 2026-06-17

- Adapted Codex configuration to the target host.

## [1.5.0] - 2026-06-17

- Added migration of local Codex marketplaces.

## [1.4.3] - 2026-05-13

- Added shared lazy-skill synchronization.

## [1.4.2] - 2026-04-30

- Resolved remote MCP binaries from common executable paths.

## [1.4.1] - 2026-04-29

- Normalized Codex MCP command paths.

## [1.4.0] - 2026-04-29

- Added explicit multi-provider push support.
- Added local restore backups and pruning of old configuration backups.
- Migrated the test suite to Vitest.

## [1.3.3] - 2026-02-26

- Fixed shell syntax in the shared-skill symlink command.

## [1.3.2] - 2026-02-26

- Included the README in the npm package.

## [1.3.1] - 2026-02-26

- Fixed remote symlink shell syntax and suppressed macOS extended-attribute warnings.

## [1.3.0] - 2026-02-26

- Prepared the CLI for npm publication and replaced Bun-specific file/process calls in core paths
  with portable runtime APIs.

## [1.2.0] - 2026-02-25

- Hardened restore safety and remote synchronization behavior.

## [1.1.0] - 2026-02-25

- Added multi-provider migration and restore workflows.

## [1.0.0] - 2026-01-31

- Initial ccm CLI for migrating Claude Code configuration.

[Unreleased]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.8.2...HEAD
[1.8.2]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.8.1...v1.8.2
[1.8.1]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.7.1...v1.8.0
[1.7.1]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.6.2...v1.7.0
[1.6.2]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.4.3...v1.5.0
[1.4.3]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.4.2...v1.4.3
[1.4.2]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.3.3...v1.4.0
[1.3.3]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/ardasevinc/claude-code-migrate/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/ardasevinc/claude-code-migrate/releases/tag/v1.1.0
[1.0.0]: https://github.com/ardasevinc/claude-code-migrate/commits/e5a0404
