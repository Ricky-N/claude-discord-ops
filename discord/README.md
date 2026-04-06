# Discord Ops

Ops-oriented Discord channel plugin for Claude Code. Built on the [official Anthropic Discord plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord) with additions for team operations:

- **Bot embed support** — GitHub, Sentry, GCP alerts, and other webhook integrations that use Discord embeds instead of plain text. The plugin extracts readable content from embeds and delivers it to Claude.
- **Deferred embed resolution** — Discord often fires `messageCreate` with empty embeds, then resolves them via `messageUpdate`. The plugin tracks these and re-delivers once content is available.
- **Reaction tracking** — Human emoji reactions in monitored channels are surfaced as signal. Knowing someone acknowledged or flagged a message helps Claude prioritize.
- **Thread auto-join** — Threads created in monitored channels are automatically joined so threaded conversations aren't invisible.
- **Channel-level bot message policy** — `allowBotMessages: true` per channel, so you control which channels forward bot/webhook traffic.
- **Chat queue** — Every inbound message is tracked in a persistent queue. Messages that arrive during deep work don't get lost — Claude can call `check_queue` to see what needs a response, and `ack_message` to signal "I'm on it." Unreplied messages automatically re-notify after a configurable timeout.

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
| `reply` | Send to a channel. `chat_id` + `text`, optional `reply_to` and `files`. Auto-chunks. Automatically marks pending queue entries for that channel as responded. |
| `react` | Add emoji reaction by message ID. |
| `edit_message` | Edit a bot message. No push notification — send a new reply when done. |
| `fetch_messages` | Pull recent history (up to 100). Oldest-first, includes embed content. |
| `download_attachment` | Download attachments to `~/.claude/channels/discord/inbox/`. |
| `check_queue` | Show all messages awaiting a response, oldest-first. Call after deep work or context compaction. |
| `ack_message` | Mark a message as "seen, will respond." Stops escalation reminders for that message. |

## Chat queue

The plugin tracks every inbound message in `~/.claude/channels/discord/queue.json`. Each message moves through states:

```
received → pending → acked → responded
                ↓
           (timeout) → re-notified
```

- **Auto-respond**: When you `reply` to a channel, all pending/acked entries for that `chat_id` transition to `responded`. No extra tool call needed.
- **Escalation with backoff**: Unresponded messages get a consolidated reminder with exponential backoff. Default: first reminder at ~10min, then ~30min, then ~90min. Three reminders over ~2 hours instead of rapid-fire interruptions.
- **Ack to pause**: Call `ack_message` when you've seen something but need time. Acked messages don't escalate.
- **Auto-cleanup**: Responded entries prune after 1 hour. Stale pending entries prune after 24 hours.

### Queue config

Add to `access.json`:

```jsonc
{
  // Base minutes before first reminder. Exponential backoff: base * 3^n.
  // Default: 10. With max=3: reminders at ~10m, ~30m, ~90m. Set 0 to disable.
  "queueEscalationBaseMinutes": 10,
  // Max re-notifications per message. Default: 3.
  "queueMaxEscalations": 3
}
```

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, guild channels, mention detection, delivery config, and the `access.json` schema.

## Headless / VM deployment

This plugin works on headless VMs (no human at a terminal). Key notes:

**Launch command:**
```bash
claude --dangerously-skip-permissions \
       --dangerously-load-development-channels plugin:discord@claude-discord-ops
```

The `--dangerously-load-development-channels` flag is required for custom marketplace plugins not on Anthropic's official approved list. It triggers an interactive confirmation prompt on startup — press Enter to proceed.

**Running as a service:** Claude Code requires a real TTY (it's a TUI app). Use `tmux` to provide one:

```bash
# Start
tmux new-session -d -s claude -x 120 -y 40 \
  'cd /path/to/monorepo && claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:discord@claude-discord-ops'
sleep 8
tmux send-keys -t claude Enter   # auto-confirm the dev channels prompt

# Stop
tmux send-keys -t claude C-c
sleep 5
tmux kill-session -t claude

# Check status
tmux capture-pane -t claude -p | tail -20
```

**Why not systemd?** Claude Code detects non-interactive terminals and switches to `--print` mode (expects stdin input and exits). The `script` command provides a PTY but can't pass through the interactive confirmation prompt reliably. tmux gives a real terminal that survives SSH disconnects.

**State files that must persist across restarts:**
- `~/.claude/channels/discord/access.json` — channel configs and user allowlist
- `~/.claude/channels/discord/queue.json` — pending message queue (recovered on startup)
- `~/.claude/.credentials.json` — Anthropic OAuth tokens (auto-refreshed)
- `~/.claude/settings.json` — user-level plugin configuration

**Authentication:** Claude Code uses OAuth with auto-refresh. Run `claude setup-token` on a machine with a browser, then copy `~/.claude/.credentials.json` to the VM. The access token auto-refreshes using the refresh token.

## Upstream

Derived from [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) (Apache-2.0). The official plugin covers core messaging, pairing, and access control. This fork adds the ops layer.
