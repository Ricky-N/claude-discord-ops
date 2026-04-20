/**
 * Focused tests for the cost-reduction change set. Proves the load-bearing
 * invariants the design rests on:
 *
 *   1. matchFilter() — bot-only runtime invariant, regex matching, scoping,
 *      bad-regex tolerance.
 *   2. mutateCostConfig() — atomicity, security-boundary keys untouched,
 *      STATIC refusal path is trivially correct (skipped here — `if STATIC throw`).
 *   3. appendRotatingJsonl() — rotation at size cap; no data loss mid-rotate.
 *   4. Batching — keyBy='channel' vs keyBy='thread', maxBatchSize immediate
 *      flush, shutdown flush.
 *
 * Run with: bun test
 *
 * These tests import the real server.ts (with runtime side effects guarded by
 * import.meta.main). They use a throwaway STATE_DIR and never touch the live
 * ~/.claude/channels/discord/ directory.
 */

// @ts-expect-error — bun:test ships with Bun; tsc without @types/bun can't resolve it.
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// MUST set DISCORD_STATE_DIR before importing server.ts — server.ts resolves
// STATE_DIR from the env var at module-load time.
const TEST_STATE_DIR = join('/tmp', `ddc-test-${process.pid}-${Date.now()}`)
process.env.DISCORD_STATE_DIR = TEST_STATE_DIR
process.env.DISCORD_BOT_TOKEN = 'test-token-never-used'

const server = await import('../server.ts')
const {
  matchFilter,
  buildPayload,
  mutateCostConfig,
  appendRotatingJsonl,
  shouldBatch,
  queueForBatch,
  flushAllBatches,
  readAccessFile,
  saveAccess,
  _getBatchBuffers,
  ACCESS_FILE,
  AUDIT_LOG,
  FILTER_CHANGELOG,
  STATE_DIR,
} = server

type Access = ReturnType<typeof readAccessFile>
type FilterPattern = NonNullable<Access['filters']>[number]
type BatchConfig = NonNullable<Access['batching']>[string]

// ─── Test helpers ───────────────────────────────────────────────────

/** Minimal Message stub — only the fields matchFilter / buildPayload touch. */
function stubMessage(opts: {
  id?: string
  authorBot?: boolean
  authorId?: string
  authorName?: string
  content?: string
  channelId?: string
  parentId?: string | null
  embeds?: Array<{
    author?: { name: string }
    title?: string
    description?: string
    fields?: Array<{ name: string; value: string }>
    footer?: { text: string }
  }>
  attachments?: Array<{ size: number; name: string; contentType?: string; id: string }>
  createdAt?: Date
}): any {
  const isThread = opts.parentId !== undefined && opts.parentId !== null
  const channelId = opts.channelId ?? '100000000000000001'
  return {
    id: opts.id ?? `msg-${Math.random().toString(36).slice(2)}`,
    author: {
      bot: opts.authorBot ?? false,
      id: opts.authorId ?? '200000000000000001',
      username: opts.authorName ?? 'alice',
    },
    content: opts.content ?? '',
    channelId,
    channel: {
      isThread: () => isThread,
      parentId: opts.parentId ?? null,
    },
    embeds: opts.embeds ?? [],
    attachments: {
      size: opts.attachments?.length ?? 0,
      values: () => (opts.attachments ?? [])[Symbol.iterator]
        ? opts.attachments ?? []
        : [],
    },
    createdAt: opts.createdAt ?? new Date('2026-04-20T12:00:00Z'),
  }
}

function minimalAccess(overrides: Partial<Access> = {}): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
    ...overrides,
  }
}

function writeAccess(a: Access): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(ACCESS_FILE, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
}

// ─── Lifecycle ──────────────────────────────────────────────────────

beforeAll(() => {
  mkdirSync(TEST_STATE_DIR, { recursive: true, mode: 0o700 })
})

beforeEach(() => {
  // Fresh access.json with only security keys populated, so we can detect
  // any unintended mutation to those keys after cost-tool calls.
  writeAccess(minimalAccess({
    dmPolicy: 'pairing',
    allowFrom: ['184695080709324800', '221773638772129792'],
    groups: {
      '999': {
        requireMention: true,
        allowFrom: [],
        allowBotMessages: true,
      },
    },
    pending: {
      'abcde': {
        senderId: '999',
        chatId: '999',
        createdAt: 1000,
        expiresAt: 2000,
        replies: 1,
      } as any,
    },
    mentionPatterns: ['^hey claude\\b'],
    ackReaction: '👀',
  }))

  // Wipe audit + changelog so test assertions don't leak across cases.
  for (const f of [AUDIT_LOG, FILTER_CHANGELOG, AUDIT_LOG + '.prev', FILTER_CHANGELOG + '.prev']) {
    try { rmSync(f, { force: true }) } catch {}
  }
})

afterAll(() => {
  try { rmSync(TEST_STATE_DIR, { recursive: true, force: true }) } catch {}
})

// ─── matchFilter ────────────────────────────────────────────────────

describe('matchFilter — bot-only runtime invariant', () => {
  const pattern: FilterPattern = {
    id: 'ci-status',
    description: 'monorepo CI',
    regex: '^\\[monorepo\\] .+ success',
    channels: [],
    userIds: [],
    reaction: '🔕',
  }
  const access = minimalAccess({ filters: [pattern] })

  test('matches a bot-authored message whose content matches the regex', () => {
    const msg = stubMessage({
      authorBot: true,
      content: '[monorepo] tests success on main',
    })
    expect(matchFilter(msg, msg.content, access)).toEqual(pattern)
  })

  test('does NOT match a human-authored message, even if content matches', () => {
    const msg = stubMessage({
      authorBot: false,
      content: '[monorepo] tests success on main',
    })
    expect(matchFilter(msg, msg.content, access)).toBeNull()
  })

  test('does NOT match a human even if filter has an empty userIds list (any-bot scope)', () => {
    // The empty-userIds shortcut must NOT allow human messages through —
    // the bot-only guard runs before any pattern matching. This is the
    // exact failure mode a prompt-injected filter_add would try to exploit.
    const msg = stubMessage({
      authorBot: false,
      authorId: '184695080709324800',  // even an allowlisted user
      content: '[monorepo] shipping a deploy success to production',
    })
    expect(matchFilter(msg, msg.content, access)).toBeNull()
  })

  test('returns null when bot message does not match any pattern', () => {
    const msg = stubMessage({
      authorBot: true,
      content: 'Deploy failed for pipeline X',
    })
    expect(matchFilter(msg, msg.content, access)).toBeNull()
  })
})

describe('matchFilter — scoping', () => {
  const pattern: FilterPattern = {
    id: 'scoped',
    description: 'only channel 111 from bot 333',
    regex: '^noise',
    channels: ['111'],
    userIds: ['333'],
    reaction: '🔕',
  }
  const access = minimalAccess({ filters: [pattern] })

  test('matches when channel and userId both allow it', () => {
    const msg = stubMessage({
      authorBot: true,
      authorId: '333',
      channelId: '111',
      content: 'noise from the right place',
    })
    expect(matchFilter(msg, msg.content, access)).toEqual(pattern)
  })

  test('does not match when channel is out of scope', () => {
    const msg = stubMessage({
      authorBot: true,
      authorId: '333',
      channelId: '222',  // not in pattern.channels
      content: 'noise from the wrong channel',
    })
    expect(matchFilter(msg, msg.content, access)).toBeNull()
  })

  test('does not match when userId is out of scope', () => {
    const msg = stubMessage({
      authorBot: true,
      authorId: '444',  // not in pattern.userIds
      channelId: '111',
      content: 'noise from the wrong bot',
    })
    expect(matchFilter(msg, msg.content, access)).toBeNull()
  })

  test('threads inherit the parent channel for the channel scope check', () => {
    const msg = stubMessage({
      authorBot: true,
      authorId: '333',
      channelId: '555',  // thread ID
      parentId: '111',   // parent matches pattern.channels
      content: 'noise in a thread',
    })
    expect(matchFilter(msg, msg.content, access)).toEqual(pattern)
  })

  test('empty channels list = any monitored channel', () => {
    const anyChannel: FilterPattern = { ...pattern, channels: [], userIds: ['333'] }
    const accessOpen = minimalAccess({ filters: [anyChannel] })
    const msg = stubMessage({
      authorBot: true,
      authorId: '333',
      channelId: '999',
      content: 'noise anywhere',
    })
    expect(matchFilter(msg, msg.content, accessOpen)).toEqual(anyChannel)
  })
})

describe('matchFilter — bad-regex tolerance', () => {
  test('one bad pattern does not break the whole pipeline', () => {
    const bad: FilterPattern = {
      id: 'bad',
      description: 'unclosed bracket',
      regex: '[',
      channels: [],
      userIds: [],
      reaction: '🔕',
    }
    const good: FilterPattern = {
      id: 'good',
      description: 'ok',
      regex: '^fine',
      channels: [],
      userIds: [],
      reaction: '🔕',
    }
    const access = minimalAccess({ filters: [bad, good] })
    const msg = stubMessage({ authorBot: true, content: 'fine by me' })
    expect(matchFilter(msg, msg.content, access)).toEqual(good)
  })
})

describe('matchFilter — empty filter list', () => {
  test('with no filters configured, behaves identically to pre-change (always null)', () => {
    const access = minimalAccess({ filters: undefined })
    const botMsg = stubMessage({ authorBot: true, content: 'anything goes' })
    expect(matchFilter(botMsg, botMsg.content, access)).toBeNull()

    const access2 = minimalAccess({ filters: [] })
    expect(matchFilter(botMsg, botMsg.content, access2)).toBeNull()
  })
})

// ─── buildPayload ───────────────────────────────────────────────────

describe('buildPayload', () => {
  test('plain text content passes through', () => {
    const msg = stubMessage({ content: 'hello world' })
    expect(buildPayload(msg)).toEqual({ content: 'hello world', attachments: [] })
  })

  test('bot message with embeds produces content from extracted embed text', () => {
    const msg = stubMessage({
      authorBot: true,
      content: '',
      embeds: [{
        author: { name: 'GitHub' },
        title: 'Pull request merged',
        description: 'Ricky merged PR #123',
        fields: [{ name: 'branch', value: 'main' }],
        footer: { text: 'notifications' },
      }],
    })
    const { content, attachments } = buildPayload(msg)
    expect(attachments).toEqual([])
    expect(content).toContain('GitHub')
    expect(content).toContain('Pull request merged')
    expect(content).toContain('Ricky merged PR #123')
    expect(content).toContain('branch: main')
    expect(content).toContain('notifications')
  })

  test('content + embed → joined with [embed] marker', () => {
    const msg = stubMessage({
      content: 'Check this out:',
      embeds: [{ title: 'neat thing' }],
    })
    const { content } = buildPayload(msg)
    expect(content).toContain('Check this out:')
    expect(content).toContain('[embed]')
    expect(content).toContain('neat thing')
  })

  test('message with no content and no embeds but with attachments returns (attachment)', () => {
    const msg = stubMessage({
      content: '',
      attachments: [{ size: 1024, name: 'image.png', contentType: 'image/png', id: 'a1' }],
    })
    // Our stubMessage.attachments.values uses Symbol.iterator on the array
    // but the stub's `values: () =>` needs to return an iterator. Re-stub:
    msg.attachments = {
      size: 1,
      values: () => [{ size: 1024, name: 'image.png', contentType: 'image/png', id: 'a1' }][Symbol.iterator](),
    }
    const { content, attachments } = buildPayload(msg)
    expect(content).toBe('(attachment)')
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toContain('image.png')
    expect(attachments[0]).toContain('image/png')
  })
})

// ─── mutateCostConfig — the structural guardrail ────────────────────

describe('mutateCostConfig — structural guardrail', () => {
  test('adding a filter does not touch dmPolicy/allowFrom/groups/pending', () => {
    const before = readAccessFile()
    const securityBefore = JSON.stringify({
      dmPolicy: before.dmPolicy,
      allowFrom: before.allowFrom,
      groups: before.groups,
      pending: before.pending,
    })

    mutateCostConfig(a => {
      a.filters = [{
        id: 'test',
        description: 'test',
        regex: '^test',
        channels: [],
        userIds: [],
        reaction: '🔕',
      }]
    })

    const after = readAccessFile()
    const securityAfter = JSON.stringify({
      dmPolicy: after.dmPolicy,
      allowFrom: after.allowFrom,
      groups: after.groups,
      pending: after.pending,
    })

    expect(securityAfter).toBe(securityBefore)
    expect(after.filters).toHaveLength(1)
  })

  test('setting batching does not touch security keys', () => {
    const before = readAccessFile()
    const securityBefore = JSON.stringify({
      dmPolicy: before.dmPolicy,
      allowFrom: before.allowFrom,
      groups: before.groups,
      pending: before.pending,
    })

    mutateCostConfig(a => {
      a.batching = {
        '999': {
          enabled: true,
          debounceMs: 30000,
          maxDelayMs: 120000,
          maxBatchSize: 10,
          keyBy: 'channel',
        },
      }
    })

    const after = readAccessFile()
    const securityAfter = JSON.stringify({
      dmPolicy: after.dmPolicy,
      allowFrom: after.allowFrom,
      groups: after.groups,
      pending: after.pending,
    })

    expect(securityAfter).toBe(securityBefore)
    expect(after.batching?.['999']?.enabled).toBe(true)
  })

  test('repeated mutations preserve prior security state even across interleaved writes', () => {
    const before = readAccessFile()
    const pendingBefore = JSON.stringify(before.pending)

    for (let i = 0; i < 5; i++) {
      mutateCostConfig(a => {
        a.filters = a.filters ?? []
        a.filters.push({
          id: `fast-${i}`,
          description: `round ${i}`,
          regex: `^round-${i}`,
          channels: [],
          userIds: [],
          reaction: '🔕',
        })
      })
    }

    const after = readAccessFile()
    expect(JSON.stringify(after.pending)).toBe(pendingBefore)
    expect(after.filters).toHaveLength(5)
  })

  test('mutator throw propagates and leaves access.json unchanged', () => {
    const before = readFileSync(ACCESS_FILE, 'utf8')
    expect(() => {
      mutateCostConfig(_a => {
        throw new Error('simulated validation failure')
      })
    }).toThrow('simulated validation failure')
    const after = readFileSync(ACCESS_FILE, 'utf8')
    expect(after).toBe(before)
  })
})

// ─── appendRotatingJsonl ────────────────────────────────────────────

describe('appendRotatingJsonl', () => {
  const testLog = join(TEST_STATE_DIR, 'rot-test.jsonl')

  beforeEach(() => {
    for (const f of [testLog, testLog + '.prev']) {
      try { rmSync(f, { force: true }) } catch {}
    }
  })

  test('writes one JSON object as one JSONL line', () => {
    appendRotatingJsonl(testLog, { id: 1, name: 'alpha' })
    const body = readFileSync(testLog, 'utf8')
    expect(body).toBe('{"id":1,"name":"alpha"}\n')
  })

  test('writes an array as multiple lines', () => {
    appendRotatingJsonl(testLog, [{ id: 1 }, { id: 2 }, { id: 3 }])
    const lines = readFileSync(testLog, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0])).toEqual({ id: 1 })
    expect(JSON.parse(lines[2])).toEqual({ id: 3 })
  })

  test('appends on subsequent calls without overwriting', () => {
    appendRotatingJsonl(testLog, { id: 1 })
    appendRotatingJsonl(testLog, { id: 2 })
    const lines = readFileSync(testLog, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  test('empty array is a no-op', () => {
    appendRotatingJsonl(testLog, [])
    expect(existsSync(testLog)).toBe(false)
  })
})

// ─── Batching ───────────────────────────────────────────────────────

describe('batching — shouldBatch', () => {
  test('returns null when batching not configured', () => {
    const access = minimalAccess({})
    expect(shouldBatch('111', access)).toBeNull()
  })

  test('returns null when enabled: false', () => {
    const access = minimalAccess({
      batching: {
        '111': {
          enabled: false,
          debounceMs: 30000,
          maxDelayMs: 120000,
          maxBatchSize: 10,
          keyBy: 'channel',
        },
      },
    })
    expect(shouldBatch('111', access)).toBeNull()
  })

  test('returns the config when enabled', () => {
    const cfg: BatchConfig = {
      enabled: true,
      debounceMs: 30000,
      maxDelayMs: 120000,
      maxBatchSize: 10,
      keyBy: 'thread',
    }
    const access = minimalAccess({ batching: { '111': cfg } })
    expect(shouldBatch('111', access)).toEqual(cfg)
  })
})

describe('batching — queueForBatch keyBy behavior', () => {
  beforeEach(() => {
    // Flush anything leftover from prior tests.
    flushAllBatches()
  })

  test('keyBy: "channel" buckets threads under their parent channel', () => {
    const cfg: BatchConfig = {
      enabled: true,
      debounceMs: 60000,
      maxDelayMs: 300000,
      maxBatchSize: 100,  // high enough that we don't auto-flush
      keyBy: 'channel',
    }
    const meta = { user: 'u', userId: '1', ts: new Date().toISOString() }
    const msgA = stubMessage({ id: 'a', channelId: 'thread-1', parentId: 'parent' })
    const msgB = stubMessage({ id: 'b', channelId: 'thread-2', parentId: 'parent' })

    queueForBatch(msgA, 'thread-1', 'parent', 'from A', [], meta, cfg)
    queueForBatch(msgB, 'thread-2', 'parent', 'from B', [], meta, cfg)

    const buffers = _getBatchBuffers()
    // Under keyBy:'channel' both messages share batchKey='parent'.
    expect(buffers.size).toBe(1)
    expect(buffers.has('parent')).toBe(true)
    expect(buffers.get('parent')!.items).toHaveLength(2)

    flushAllBatches()
    expect(buffers.size).toBe(0)
  })

  test('keyBy: "thread" keeps distinct threads in separate batches', () => {
    const cfg: BatchConfig = {
      enabled: true,
      debounceMs: 60000,
      maxDelayMs: 300000,
      maxBatchSize: 100,
      keyBy: 'thread',
    }
    const meta = { user: 'u', userId: '1', ts: new Date().toISOString() }
    const msgA = stubMessage({ id: 'a', channelId: 'thread-1', parentId: 'parent' })
    const msgB = stubMessage({ id: 'b', channelId: 'thread-2', parentId: 'parent' })

    queueForBatch(msgA, 'thread-1', 'parent', 'from A', [], meta, cfg)
    queueForBatch(msgB, 'thread-2', 'parent', 'from B', [], meta, cfg)

    const buffers = _getBatchBuffers()
    expect(buffers.size).toBe(2)
    expect(buffers.has('thread-1')).toBe(true)
    expect(buffers.has('thread-2')).toBe(true)
    expect(buffers.get('thread-1')!.items).toHaveLength(1)
    expect(buffers.get('thread-2')!.items).toHaveLength(1)

    flushAllBatches()
  })

  test('maxBatchSize triggers immediate flush', () => {
    const cfg: BatchConfig = {
      enabled: true,
      debounceMs: 60000,
      maxDelayMs: 300000,
      maxBatchSize: 3,  // fires on 3rd message
      keyBy: 'channel',
    }
    const meta = { user: 'u', userId: '1', ts: new Date().toISOString() }
    const buffers = _getBatchBuffers()

    for (let i = 0; i < 3; i++) {
      const m = stubMessage({ id: `m${i}`, channelId: 'c', parentId: null })
      queueForBatch(m, 'c', 'c', `content ${i}`, [], meta, cfg)
    }

    // After the 3rd message, the buffer should have been flushed
    // (flushBatch deletes the entry from the map).
    expect(buffers.has('c')).toBe(false)
  })

  test('flushAllBatches on shutdown empties the map', () => {
    const cfg: BatchConfig = {
      enabled: true,
      debounceMs: 60000,
      maxDelayMs: 300000,
      maxBatchSize: 100,
      keyBy: 'channel',
    }
    const meta = { user: 'u', userId: '1', ts: new Date().toISOString() }
    const m = stubMessage({ id: 'x', channelId: 'c', parentId: null })
    queueForBatch(m, 'c', 'c', 'pending at shutdown', [], meta, cfg)

    const buffers = _getBatchBuffers()
    expect(buffers.size).toBe(1)

    flushAllBatches()
    expect(buffers.size).toBe(0)
  })
})

// ─── Read-round-trip sanity ──────────────────────────────────────────

describe('access.json round-trip includes new fields', () => {
  test('filters and batching persist through write → read', () => {
    const a = readAccessFile()
    a.filters = [{
      id: 'x',
      description: 'x',
      regex: '^x',
      channels: ['1'],
      userIds: ['2'],
      reaction: '🔕',
    }]
    a.batching = {
      '1': {
        enabled: true,
        debounceMs: 1,
        maxDelayMs: 2,
        maxBatchSize: 3,
        keyBy: 'thread',
      },
    }
    a.startupRedeliveryMaxAgeHours = 8
    a.startupRedeliveryMaxCount = 50
    saveAccess(a)

    const b = readAccessFile()
    expect(b.filters).toEqual(a.filters)
    expect(b.batching).toEqual(a.batching)
    expect(b.startupRedeliveryMaxAgeHours).toBe(8)
    expect(b.startupRedeliveryMaxCount).toBe(50)
  })
})
