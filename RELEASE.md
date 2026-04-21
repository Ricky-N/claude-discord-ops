# Release process

The Discord plugin ships under a single `version` field in
[`discord/.claude-plugin/plugin.json`](./discord/.claude-plugin/plugin.json).
Claude Code's plugin manager uses that field — not the git SHA — to decide
whether `claude plugin update` has anything to fetch. If the version doesn't
change, consumers stay pinned to whatever SHA they installed at, even if
they explicitly ask for an update.

**Rule: any PR touching `discord/**` bumps the version.**

Enforced in CI by [`.github/workflows/plugin-version-check.yml`](./.github/workflows/plugin-version-check.yml).
PRs that only touch root-level files (this doc, repo README, `docs/`, `.github/`) don't need a bump.

## Semver flavor

Loose semver. Pick the closest fit:

| Bump | When |
| --- | --- |
| MAJOR (`X.0.0`) | Breaking change — `access.json` schema incompatibility, removed/renamed MCP tool, tool semantics that existing callers depend on. Rare. |
| MINOR (`0.Y.0`) | New feature — added MCP tool, new config key, new optional behavior. |
| PATCH (`0.0.Z`) | Bug fix, doc tweak, non-behavioral refactor. |

Keep `discord/package.json` `version` in sync with `plugin.json` for clarity. Only `plugin.json` is load-bearing for updates.

## Cutting a release

1. **On the PR that ships the change:**
   - Bump `version` in `discord/.claude-plugin/plugin.json` (and `discord/package.json`).
   - Merge to main. CI blocks the merge if the bump was missing.

2. **After merge, tag and publish release notes:**
   ```sh
   git checkout main && git pull
   git tag -a v0.2.0 -m "v0.2.0: <one-line summary>"
   git push origin v0.2.0
   gh release create v0.2.0 --title "v0.2.0" --notes-file -  # or --notes "..."
   ```

3. **Consumers update:**
   ```sh
   claude plugin update discord@Ricky-N/claude-discord-ops
   ```
   If the update client reports they're already current but you know they
   aren't, force-reinstall:
   ```sh
   claude plugin uninstall discord@Ricky-N/claude-discord-ops
   claude plugin install   discord@Ricky-N/claude-discord-ops
   ```

## What gets a version bump

- MCP tool additions, removals, or signature changes — MINOR or MAJOR.
- Behavior changes in `server.ts` — MINOR (new feature) or PATCH (fix).
- `access.json` schema additions (new optional keys) — MINOR.
- `access.json` schema changes (renamed/removed keys) — MAJOR.
- Edits to `discord/README.md`, `discord/ACCESS.md`, `discord/FILTERS.md` — PATCH. They ship with the plugin install, so bumping makes sure consumers pull the current docs.

## What's exempt

- Root-level doc edits (this file, repo README, LICENSE).
- CI config under `.github/`.
- Proposal and design docs under `docs/`.

CI enforces this via the `paths` filter on the workflow — files outside `discord/**` don't trigger the check.
