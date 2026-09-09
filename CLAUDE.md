# Project context

Single npm package: `@davindermahal/ai-intake-mcp`.

## Releasing

Publishing happens **only** via a pushed `v<semver>` tag, never a local
`npm publish` — CI (`.github/workflows/release.yml`) builds, lints, tests,
then publishes via OIDC trusted publishing (no `NPM_TOKEN` secret). A local
`npm publish` bypasses that gate — don't use it.

1. Bump `"version"` in `package.json` (semver; patch for bug fixes).
2. Add a dated entry to `CHANGELOG.md` (`## <version> — YYYY-MM-DD` with
   `### Added`/`### Changed`/`### Fixed`, matching existing entries).
3. `npm run build && npm run lint && npm test` — CI runs all three; confirm
   locally first.
4. Commit, `git push origin main`.
5. `git tag -a v<version> -m "ai-intake-mcp <version>" && git push origin v<version>`.
6. Watch the release run: `gh run list` / `gh run watch <run-id>`.
