# Discord — Noise Filters & Batching

Cost-management layer for the plugin. Two knobs:

- **Filter** — regex match against bot-authored messages. Matches get an emoji reaction and never enter Claude's queue. Human-authored messages are never filtered.
- **Batching** — per-channel debounce. Bursty signals (PR-thread chatter, Sentry alert storms) coalesce into one consolidated wake-up per channel (or per thread).

Both live in `access.json`, alongside the security-boundary keys documented in [ACCESS.md](./ACCESS.md). The split is deliberate: **access is a security boundary, filters/batching are a cost-management lever.** The `/discord:access` skill edits security keys from the human terminal; the `filter_*` and `batching_*` MCP tools edit cost-management keys from Claude's session. The two paths cannot cross — see [Why this can be agent-managed](#why-this-can-be-agent-managed).

## At a glance

| | |
| --- | --- |
| Config file | `~/.claude/channels/discord/access.json` (keys: `filters`, `batching`, `groups[*].reactions`) |
| Change log | `~/.claude/channels/discord/filter-changelog.jsonl` |
| Hit log | `~/.claude/channels/discord/queue-audit.jsonl` (`state: "filtered"` records) |
| Editing path | MCP tools: `filter_add`, `filter_remove`, `filter_list`, `batching_set`, `batching_list` |
| Human-filterable? | No — bot-only enforced at runtime in `matchFilter()` |

## Filter pipeline

Every inbound message hits the same pipeline regardless of how Discord delivered it (`messageCreate` or `messageUpdate` embed resolution):

```
gate() → matchFilter() → hit?  → react with pattern.reaction
                                 → append state:"filtered" to queue-audit.jsonl
                                 → do NOT enqueue, do NOT notify Claude
                         miss? → ack (👀 or configured ackReaction)
                                 → batching enabled? queue for batch
                                 → otherwise: enqueue + notify Claude
```

### Runtime invariant: bot-only

The first line of `matchFilter()`:

```typescript
if (!msg.author.bot) return null
```

This runs **before** any pattern is evaluated. A typo, a bad regex, or a prompt-injected `filter_add` cannot silence a human — it's structurally impossible, not policy. That's what lets filter mutations be agent-driven without a human approval step.

## Filter config

Lives under `filters` in `access.json`:

```jsonc
{
  "filters": [
    {
      "id": "ci-status",
      "description": "Monorepo CI check status webhooks",
      "regex": "^\\[monorepo\\] .+ (success|cancelled|skipped|failure) on (main|pull request #\\d+|[\\w/-]+)$",
      "channels": ["1485029244307378186"],
      "userIds": ["1485029454517375244"],
      "reaction": "🔕"
    }
  ]
}
```

| Field | Purpose |
| --- | --- |
| `id` | Stable identifier. Echoed into `queue-audit.jsonl` on every match; used to grep for effectiveness or to narrow a false-positive. |
| `description` | One-line human-readable purpose. |
| `regex` | JavaScript RegExp source. Tested against message content **including** resolved embed text (so GitHub/Sentry-style embed payloads match). Anchor with `^` and `$` when possible. |
| `channels` | Parent channel IDs to scope to. Empty array = any monitored channel. Thread messages are keyed on the parent channel. |
| `userIds` | Bot user IDs to scope to. Empty = any bot author. Human messages are **never** matched regardless of this field. |
| `reaction` | Emoji posted on match as the audit trail. Convention: `🔕` = muted/filtered. |

Max 50 patterns. The limit is intentional — more than that and curation is falling behind.

## Batching config

Lives under `batching` in `access.json`, keyed on **parent** channel ID:

```jsonc
{
  "batching": {
    "1485029244307378186": {
      "enabled": true,
      "debounceMs": 60000,
      "maxDelayMs": 300000,
      "maxBatchSize": 20,
      "keyBy": "thread"
    }
  }
}
```

| Field | Purpose |
| --- | --- |
| `enabled` | Kill switch. |
| `debounceMs` | Quiet period after the last message before the batch flushes. Each new message resets the timer. |
| `maxDelayMs` | Hard upper bound on batch duration — messages never sit indefinitely. |
| `maxBatchSize` | Flush immediately when the batch hits this count (urgency signal). |
| `keyBy` | `"channel"`: merge everything in the channel into one batch. `"thread"`: each thread gets its own batch — the right choice for PR-activity where different threads mean different PRs. |

### What Claude sees on flush

One consolidated notification:

```
[batch of 5 in chat 1485029244307378186, 14:30:15 → 14:31:02]
- alice (14:30:15): Reviewed PR #127 — LGTM with nits
- bob   (14:30:42): Approved PR #127
- alice (14:30:58): Squashed and merged
- ci    (14:31:01): checks passed on main
- ci    (14:31:02): deploy success to staging
```

Each message still has its own `QueueEntry`, so per-message response time is measurable and a single `reply` to the `chat_id` clears the whole batch (via the existing `transitionToResponded` path).

## Per-channel reactions

Reactions were previously one MCP notification per emoji — in a bot-heavy channel with five people thumbs-upping a shipped PR, that's 5 separate model wake-ups.

Add `reactions` to a channel's `GroupPolicy`:

```jsonc
{
  "groups": {
    "1485029244307378186": {
      "requireMention": false,
      "allowBotMessages": true,
      "reactions": "drop"
    }
  }
}
```

- `"deliver"` (default, if the field is absent) — each reaction fires a notification. Preserved for human channels where reactions are signal.
- `"drop"` — reactions are silently suppressed. Use in bot-heavy channels.

This field is **inside a channel's `groups` entry** (a security-boundary key), so it's edited via `/discord:access set`, not via the cost-management MCP tools. Editing `groups[*]` requires the human terminal because changing who can trigger the bot in a channel has access-control implications.

## MCP tools

All five share one write helper (`mutateCostConfig`) that re-reads `access.json` fresh, applies the mutation to `filters` / `batching` only, and writes atomically via the existing tmp-then-rename pattern.

### `filter_add`

```
filter_add(
  pattern_id: "ci-status",
  description: "Monorepo CI check status webhooks",
  regex: "^\\[monorepo\\] .+ (success|cancelled|skipped|failure) .+$",
  channels: ["1485029244307378186"],
  user_ids: ["1485029454517375244"],
  reaction: "🔕",
  reason: "dominant CI noise — 2170 hits in 7 days"
)
```

Validations:
- `pattern_id` is unique, 1–64 chars, `[a-z0-9-]`
- `regex` compiles as a valid JavaScript RegExp
- Total pattern count stays ≤ 50
- `reason` is required (recorded in `filter-changelog.jsonl`)

### `filter_remove`

```
filter_remove(pattern_id: "ci-status", reason: "over-matched on real alerts")
```

### `filter_list`

No arguments. Returns the current patterns with their IDs, regex, scope, and reaction. For match counts, grep `queue-audit.jsonl` by `filterPatternId`:

```
grep '"state":"filtered"' ~/.claude/channels/discord/queue-audit.jsonl \
  | jq -r '.filterPatternId' | sort | uniq -c | sort -rn
```

### `batching_set`

```
batching_set(
  channel_id: "1485029244307378186",
  enabled: true,
  debounce_ms: 60000,
  max_delay_ms: 300000,
  max_batch_size: 20,
  key_by: "thread",
  reason: "PR-activity fires 20 review comments per human typing session"
)
```

Validations:
- `debounce_ms ≤ max_delay_ms`
- `max_batch_size ≥ 1`
- `key_by ∈ {"channel", "thread"}`

### `batching_list`

No arguments. Returns current per-channel config.

## Why this can be agent-managed

Filter and batching edits don't grant new privilege — they only drop useful messages. If Claude adds a bad filter, the human notices, tells Claude "you missed X," and Claude narrows the pattern:

1. Claude acknowledges.
2. Greps `queue-audit.jsonl` for entries near X's timestamp with `state: "filtered"`.
3. Identifies which pattern matched; narrows or removes it via `filter_remove` / `filter_add`.
4. Reports back in-channel with the diff.

The feedback loop self-heals. Contrast with access: a bad `allowFrom` grants access to someone who shouldn't have it — not self-healing, requires human approval.

The guardrails that make this safe:

- **Bot-only runtime invariant.** Human messages are never matched.
- **Scoped write path.** `mutateCostConfig` reads and writes the file but only the filter/batching tool handlers call it. The tool handlers only mutate `filters` / `batching` / `filter_changelog`. They cannot touch `dmPolicy` / `allowFrom` / `groups` / `pending`.
- **Append-only audit.** Every mutation is in `filter-changelog.jsonl`. Every match is in `queue-audit.jsonl`.
- **Pattern cap.** 50 patterns max. Curation becomes necessary; unbounded growth is not.
- **Emoji audit trail.** Every filtered message has a reaction in Discord. A human scrolling the channel can see at a glance what Claude skipped vs. processed.

## Feedback loop in practice

Missed message example:

```
[human in #alerts]  BeaconClaude, you missed the Postgres CPU alert from 10 min ago
[Claude]  Checking... queue-audit shows it matched ci-status (regex over-broad).
         Narrowing: ci-status now requires "[monorepo]" prefix explicitly.
         Committed: filter-changelog.jsonl records the change with reason.
```

Over-aggressive filter example:

```
[human notices no filter hits on daily Sentry noise for 3 days]
[Claude]  Added sentry-digest filter targeting the Sentry webhook user ID.
         Watching queue-audit to confirm hit rate > 0 over the next 24h.
```

## Files

```
~/.claude/channels/discord/
├─ access.json              ← filters, batching live here alongside security keys
├─ queue-audit.jsonl        ← filter hits recorded as state:"filtered"
└─ filter-changelog.jsonl   ← every filter/batching mutation, append-only
```

Both `.jsonl` files rotate to `.prev` at 5MB (handled by the shared `appendRotatingJsonl` helper in `server.ts`).
