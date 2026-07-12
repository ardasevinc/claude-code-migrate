# Contributing

ccm is a Bun CLI for macOS and Linux. npm distributes the package, but Node.js is not a supported
runtime.

## Development setup

Install Bun 1.3.14, then:

```bash
git clone https://github.com/ardasevinc/claude-code-migrate.git
cd claude-code-migrate
bun install --frozen-lockfile
bun run check
```

Use `bun src/index.ts ...` to exercise the CLI from the checkout. Keep changes focused, follow the
existing TypeScript patterns, and add regression coverage for behavior changes.

## Pull requests

- Run `bun run check` before opening the pull request.
- Explain the user-visible behavior and any compatibility or security impact.
- Do not include credentials, auth state, sessions, or machine-local configuration in fixtures.
- Use conventional commit subjects when creating commits.

For release mechanics, see [`docs/releasing.md`](docs/releasing.md). Maintainer credentials and
publishing configuration are not required for ordinary contributions.
