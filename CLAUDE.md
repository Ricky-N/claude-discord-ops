# Agent notes

## Cutting a release

Any PR that touches `discord/**` must bump `version` in
[`discord/.claude-plugin/plugin.json`](./discord/.claude-plugin/plugin.json).
Loose semver: MAJOR for breaking (rare), MINOR for new features, PATCH for
fixes and doc edits. CI
([`.github/workflows/plugin-version-check.yml`](./.github/workflows/plugin-version-check.yml))
blocks the merge if the bump is missing.

**After the release PR has merged to main, run:**

```sh
scripts/release.sh
```

One command. It:
- Preflights (on main, clean, up-to-date, tag not already used).
- Shows you the commits that'll ship, asks for confirmation.
- Creates an annotated git tag matching the version.
- Pushes the tag.
- Creates a GitHub Release with auto-generated notes (or opens `$EDITOR` on
  the very first release).

The version field in `plugin.json` is the **single source of truth** for both
the tag name and the release version. Don't pass it as an argument — bump the
manifest in a PR, merge, run the script.

See [RELEASE.md](./RELEASE.md) for the why and the semver guidance.

## Plugin update flow for consumers

```
claude plugin update discord@Ricky-N/claude-discord-ops
```

Claude Code's plugin manager keys `update` off the `version` field in
`plugin.json`, not the git SHA. If the version hasn't changed, consumers stay
pinned to whatever SHA they installed at even when they explicitly ask for
an update. That's the failure mode the CI check and release script exist to
prevent.

## Repo layout

- [`discord/`](./discord) — the plugin itself. Single-file Bun/TypeScript
  MCP server ([`server.ts`](./discord/server.ts)) with section-divider
  comments for navigation. Existing idiom: everything in one file, no new
  source files unless cross-cutting.
- [`docs/`](./docs) — design docs and proposals. Not shipped with the plugin.
- [`scripts/`](./scripts) — repo-level automation.
- [`.github/workflows/`](./.github/workflows) — CI.

## Testing

```sh
cd discord && bun test
```

The suite proves the load-bearing invariants (bot-only filter guard,
security-boundary keys untouched by cost tools, batching shape). Run it
before opening any PR that touches `server.ts`.
