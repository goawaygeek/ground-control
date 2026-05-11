import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalJsonlEventStore } from './event-store.js'

describe('LocalJsonlEventStore', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'events-test-'))
    path = join(dir, 'events.jsonl')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns an empty list when the file does not exist', async () => {
    const store = new LocalJsonlEventStore(path)
    expect(await store.listEvents()).toEqual([])
  })

  it('round-trips a logged event', async () => {
    const store = new LocalJsonlEventStore(path)
    await store.logEvent({
      type: 'player:join',
      game: 'chess',
      data: { name: 'alice' },
    })

    const all = await store.listEvents()
    expect(all).toHaveLength(1)
    expect(all[0].type).toBe('player:join')
    expect(all[0].game).toBe('chess')
    expect(all[0].data).toEqual({ name: 'alice' })
    expect(all[0].id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(typeof all[0].timestamp).toBe('string')
  })

  it('appends across separate instances (survives process restart)', async () => {
    const a = new LocalJsonlEventStore(path)
    await a.logEvent({ type: 'player:join', game: 'chess', data: {} })

    const b = new LocalJsonlEventStore(path)
    await b.logEvent({ type: 'game:start', game: 'chess', data: {} })

    const all = await b.listEvents()
    expect(all).toHaveLength(2)
    expect(all.map(e => e.type)).toEqual(['player:join', 'game:start'])
  })

  it('filters by type', async () => {
    const store = new LocalJsonlEventStore(path)
    await store.logEvent({ type: 'player:join', game: 'chess', data: {} })
    await store.logEvent({ type: 'game:start', game: 'chess', data: {} })
    await store.logEvent({ type: 'game:over', game: 'chess', data: {} })

    const starts = await store.listEvents({ type: 'game:start' })
    expect(starts).toHaveLength(1)
    expect(starts[0].type).toBe('game:start')
  })

  it('filters by game', async () => {
    const store = new LocalJsonlEventStore(path)
    await store.logEvent({ type: 'player:join', game: 'chess', data: {} })
    await store.logEvent({ type: 'player:join', game: 'comedy-battle', data: {} })

    const chess = await store.listEvents({ game: 'chess' })
    expect(chess).toHaveLength(1)
    expect(chess[0].game).toBe('chess')
  })

  it('filters by since (inclusive of newer records)', async () => {
    const store = new LocalJsonlEventStore(path)
    await store.logEvent({
      type: 'player:join',
      game: 'chess',
      data: {},
      timestamp: '2026-01-01T00:00:00.000Z',
    })
    await store.logEvent({
      type: 'player:join',
      game: 'chess',
      data: {},
      timestamp: '2026-06-01T00:00:00.000Z',
    })

    const recent = await store.listEvents({ since: new Date('2026-03-01T00:00:00.000Z') })
    expect(recent).toHaveLength(1)
    expect(recent[0].timestamp).toBe('2026-06-01T00:00:00.000Z')
  })

  it('skips malformed JSON lines instead of crashing', async () => {
    const store = new LocalJsonlEventStore(path)
    await store.logEvent({ type: 'player:join', game: 'chess', data: {} })

    // Manually corrupt the file with a junk line.
    const { appendFileSync } = await import('node:fs')
    appendFileSync(path, 'not-valid-json\n')
    await store.logEvent({ type: 'game:start', game: 'chess', data: {} })

    const all = await store.listEvents()
    expect(all).toHaveLength(2)
  })

  it('uses provided timestamp when given', async () => {
    const store = new LocalJsonlEventStore(path)
    const ts = '2026-05-11T12:00:00.000Z'
    await store.logEvent({ type: 'player:join', game: 'chess', data: {}, timestamp: ts })
    const [event] = await store.listEvents()
    expect(event.timestamp).toBe(ts)
  })
})
