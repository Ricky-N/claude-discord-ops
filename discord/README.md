# Discord Ops

Ops-oriented Discord channel plugin for Claude Code. Built on the [official Anthropic Discord plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord) with additions for team operations:

- **Bot embed support** — GitHub, Sentry, GCP alerts, and other webhook integrations that use Discord embeds instead of plain text. The plugin extracts readable content from embeds and delivers it to Claude.
- **Deferred embed resolution** — Discord often fires `messageCreate` with empty embeds, then resolves them via `messageUpdate`. The plugin tracks these and re-delivers once content is available.
- **Reaction tracking** — Human emoji reactions in monitored channels are surfaced as signal. Knowing someone acknowledged or flagged a message helps Claude prioritize.
- **Thread auto-join** — Threads created in monitored channels are automatically joined so threaded conversations aren't invisible.
- **Channel-level bot message policy** — `allowBotMessages: true` per channel, so you control which channels forward bot/webhook traffic.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`

## Setup

Same setup flow as the official plugin. If you're migrating from `discord@claude-plugins-official`, your existing `~/.claude/channels/discord/` state (token, access.json) carries over — no reconfiguration needed.

**1. Create a Discord application and bot.**

Go to the [Discord Developer Portal](https://discord.com/developers/applications). Create an app, navigate to **Bot**, enable **Message Content Intent**.

**2. Generate a bot token.**

On the **Bot** page, **Reset Token**. Copy it.

**3. Invite the bot to a server.**

**OAuth2** > **URL Generator**. Select `bot` scope. Permissions: View Channels, Send Messages, Send Messages in Threads, Read Message History, Attach Files, Add Reactions. Integration type: **Guild Install**. Open the generated URL.

**4. Install the plugin.**

```
/plugin install discord@Ricky-N/claude-discord-ops
```

**5. Give the server the token.**

```
/discord:configure <your-bot-token>
```

**6. Launch with the channel flag.**

```sh
claude --channels plugin:discord@Ricky-N/claude-discord-ops
```

**7. Pair.**

DM your bot — it replies with a pairing code. In Claude Code:

```
/discord:access pair <code>
```

## Bot message channels

To forward bot/webhook messages in a guild channel, add `allowBotMessages: true` to that channel's config in `access.json`:

```jsonc
{
  "groups": {
    "846209781206941736": {
      "requireMention": true,
      "allowFrom": [],
      "allowBotMessages": true
    }
  }
}
```

## Tools

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a channel. `chat_id` + `text`, optional `reply_to` and `files`. Auto-chunks. |
| `react` | Add emoji reaction by message ID. |
| `edit_message` | Edit a bot message. No push notification — send a new reply when done. |
| `fetch_messages` | Pull recent history (up to 100). Oldest-first, includes embed content. |
| `download_attachment` | Download attachments to `~/.claude/channels/discord/inbox/`. |

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, guild channels, mention detection, delivery config, and the `access.json` schema.

## Upstream

Derived from [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) (Apache-2.0). The official plugin covers core messaging, pairing, and access control. This fork adds the ops layer.
