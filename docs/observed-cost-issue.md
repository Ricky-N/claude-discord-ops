# EPIC(infra): BeaconClaude cost reduction — bring API-equivalent spend from $37K/mo to $8–12K/mo #1838

## What's Happening

BeaconClaude (the always-on Discord teammate) is running at ~\$37K/month equivalent cost at Claude Opus API rates. Currently covered by the Max \$200/mo subscription via cache-read discounts and output-focused quota accounting, but Anthropic is rotating OAuth tokens from GCP IPs — signaling that long-running bots on subscription credentials are increasingly unsustainable. The current economics wouldn't survive an API switch.

## Impact

- **Existential for BeaconClaude.** If Anthropic forces the API switch before we drive real cost down, the team can't absorb a \$40K/month line item and BeaconClaude goes away.
- **Team velocity.** BeaconClaude owns #user-feedback, #alerts, #event-drafts, #shipped, and #pull-request-activity. Losing that coverage means feedback goes untriaged and signals drift back to manual.

## What We Know

7-day measurement from session logs (9 sessions, 7,854 assistant turns):

- Cache reads: 3.01B tokens | Output: 1.43M tokens (97% of turns ≤1K)
- 65% of turns cross the 200K-tokens-per-request threshold into 1M-tier pricing (2x rate)
- Two long-running Discord-watcher sessions account for 93% of spend
- **82% of the watcher's 2,658 inbound Discord messages are routine CI/bot noise** (`[monorepo] X success on PR #N`, etc.) that invariably get "No action." responses. ~\$2,850/wk waste.
- Every emoji reaction and every MCP reconnect adds further wake-ups on top of that 2,658 count — uncounted but real contributors to the $37K.
- Cache hit rate already 99.1% — caching isn't the lever; smaller context / fewer turns is.

## Proposed Fix

One consolidated change to the forked Discord plugin. Built end-to-end, validated in staging, shipped in a single pass — no phased rollout. The levers reinforce each other; measuring them independently wastes cycles.

1. **Inbound filter layer** — regex match on bot-authored messages before they enter Claude's queue. Matched messages get an emoji reaction and never wake the model. Applied at every delivery path (`messageCreate` AND the `messageUpdate` embed-resolution path). Bot-only enforced at runtime, not just by convention.
2. **Per-channel batching** — debounce medium-value signals (Sentry bursts, PR-thread chatter) into one aggregated wake-up per channel. `keyBy: "thread"` for PR-activity so we don't aggregate across unrelated PRs.
3. **Reaction + thread-create aggregation** — stop treating every emoji reaction and every `threadCreate` event as an independent model wake-up in bot-heavy channels.
4. **Plugin-local base-context trim** — shrink the MCP server's `instructions` block and verbose tool descriptions (~1.9KB per session cold start).
5. **Bounded startup re-delivery** — cap the "unresponded messages from prior session" replay so MCP reconnects don't compound cost.
6. **Filter-aware queue audit** — extend `queue-audit.jsonl` with a `filtered` state so filter-hit counts live alongside response-time data in one source of truth.
7. **Weekly cost report** — automated Discord post that **joins** `queue-audit.jsonl` (Discord-side activity) with session logs (Claude-side cost). The two data sources are complementary, not duplicative — neither alone can answer "did filtering actually reduce cost?"

Filter and batching configs live in `access.json` under two new top-level keys (`filters`, `batching`). Five new MCP tools (`filter_add`, `filter_remove`, `filter_list`, `batching_set`, `batching_list`) let BeaconClaude self-manage them; the handlers by construction mutate only those keys, never `allowFrom` / `dmPolicy` / `groups` / `pending`. Every mutation appends to a separate `filter-changelog.jsonl` file (same append-only idiom as the existing `queue-audit.jsonl`). Filter is a cost-management lever, not a security surface — Claude must not be blocked from managing it.

**Harness-level changes** (Claude Code compaction tuning, broad tool-result truncation, CLAUDE.md/memory audit) are explicitly deferred. They require upstream Claude Code work or monorepo-level changes and aren't in this repo's scope. Landing them later brings the floor down to $5–8K.

### Expected cost reduction

| Stage | Monthly at API rates |
|---|---|
| Today | \$37K |
| After plugin-local change set (this PR) | **\$8–12K** |
| Ceiling if harness-level follow-ons land later | \$5–8K |

## Resolved When

- [ ] Proposal PR #1837 reviewed and merged
- [ ] Consolidated plugin change built, validated in a staging watcher session over 48h of synthetic traffic — filter hit rate ≥75%, zero false positives on human-authored messages
- [ ] Weekly-report script operational before rollout — we need the ruler before we cut
- [ ] Shipped to production
- [ ] Measured weekly cost ≤\$2.5K (monthly run rate ≤\$10–12K) sustained over 7 days post-rollout
- [ ] Zero open false-negative reports (human flags of "you missed X" caused by filter)

## Context

- Surfaced during token-cost deep-dive in #chat-with-claude on 2026-04-20
- Related: Anthropic OAuth rotation from GCP IPs (driving the urgency — Max credential runway is finite)
- Related: `claude-channels-ops` proposal (BeaconClaude's operational identity; not changed by this work)
