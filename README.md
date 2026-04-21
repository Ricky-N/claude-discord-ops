# claude-discord-ops

Claude Code plugins for Discord-based team operations.

## Plugins

### [discord](./discord/)

Ops-oriented Discord channel plugin for Claude Code. Extends the [official Anthropic Discord plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord) with bot embed support, reaction tracking, thread monitoring, and a persistent chat queue that ensures messages are never dropped during deep work.

```
/plugin install discord@Ricky-N/claude-discord-ops
```

See [discord/README.md](./discord/README.md) for setup and configuration.

## Releasing

Any PR touching `discord/**` must bump `version` in
[`discord/.claude-plugin/plugin.json`](./discord/.claude-plugin/plugin.json).
Claude Code's plugin manager keys `claude plugin update` off that field, so
unchanged versions mean consumers silently stay on the old SHA. CI enforces
the bump ([`.github/workflows/plugin-version-check.yml`](./.github/workflows/plugin-version-check.yml)).

After the release PR merges to main, run:

```sh
scripts/release.sh
```

That's it — one command. It tags, pushes, and creates the GitHub Release
with auto-generated notes. Consumers then `claude plugin update
discord@Ricky-N/claude-discord-ops` to fetch.

See [`RELEASE.md`](./RELEASE.md) for the semver guidance and edge cases.

## License

Apache-2.0. Derived from [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official).
