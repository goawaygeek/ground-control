import { describe, it, expect, beforeEach } from 'vitest'
import { Analytics } from './analytics.js'
import type { EventStore, AnalyticsRecord, LogEventInput } from './event-store.js'
import { GameRoom } from './game-room.js'
import { ChessGame } from './game/chess/index.js'

class InMemoryEventStore implements EventStore {
  records: AnalyticsRecord[] = []

  async logEvent(input: LogEventInput): Promise<void> {
    this.records.push({
      id: `rec-${this.records.length}`,
      timestamp: input.timestamp ?? new Date().toISOString(),
      type: input.type,
      game: input.game,
      data: input.data,
    })
  }

  async listEvents(): Promise<AnalyticsRecord[]> {
    return [...this.records]
  }
}

describe('Analytics', () => {
  let store: InMemoryEventStore
  let analytics: Analytics

  beforeEach(() => {
    store = new InMemoryEventStore()
    analytics = new Analytics(store)
  })

  it('recordJoin writes a player:join record', async () => {
    await analytics.recordJoin({ game: 'chess', name: 'alice', isReconnect: false })
    expect(store.records).toHaveLength(1)
    expect(store.records[0].type).toBe('player:join')
    expect(store.records[0].game).toBe('chess')
    expect(store.records[0].data).toMatchObject({ name: 'alice', isReconnect: false })
  })

  it('subscribes to a room and records game:start and game:over', async () => {
    const room = new GameRoom(new ChessGame())
    analytics.subscribe(room)

    const alice = await room.sessions.joinPlayer('alice')
    if (!alice.ok) throw new Error('join failed')
    room.dispatchEvents(room.game.onPlayerJoin({ name: 'alice', token: alice.token, role: 'audience' }))

    // play_bot starts a game and immediately allows resignation, which ends it.
    const playResult = room.game.onAction(
      { name: 'alice', token: alice.token, role: 'lobby' },
      'play_bot',
      {},
    )
    room.dispatchEvents(playResult.events)

    const resignResult = room.game.onAction(
      { name: 'alice', token: alice.token, role: 'white' },
      'resign',
      {},
    )
    room.dispatchEvents(resignResult.events)

    // Allow setImmediate/microtasks to flush, in case future async hooks land.
    await new Promise(setImmediate)

    const starts = store.records.filter(r => r.type === 'game:start')
    const overs = store.records.filter(r => r.type === 'game:over')
    expect(starts).toHaveLength(1)
    expect(overs).toHaveLength(1)
  })

  it('marks includesBot=true when one side is named chessbot', async () => {
    const room = new GameRoom(new ChessGame())
    analytics.subscribe(room)

    const alice = await room.sessions.joinPlayer('alice')
    if (!alice.ok) throw new Error('join failed')
    room.dispatchEvents(room.game.onPlayerJoin({ name: 'alice', token: alice.token, role: 'audience' }))

    const playResult = room.game.onAction(
      { name: 'alice', token: alice.token, role: 'lobby' },
      'play_bot',
      {},
    )
    room.dispatchEvents(playResult.events)

    const start = store.records.find(r => r.type === 'game:start')!
    expect(start.data.includesBot).toBe(true)
  })

  it('computes durationMs on game:over using the matching game:start timestamp', async () => {
    const room = new GameRoom(new ChessGame())
    analytics.subscribe(room)

    const alice = await room.sessions.joinPlayer('alice')
    if (!alice.ok) throw new Error('join failed')
    room.dispatchEvents(room.game.onPlayerJoin({ name: 'alice', token: alice.token, role: 'audience' }))

    const playResult = room.game.onAction(
      { name: 'alice', token: alice.token, role: 'lobby' },
      'play_bot',
      {},
    )
    room.dispatchEvents(playResult.events)

    // Tiny delay so durationMs is non-zero.
    await new Promise(resolve => setTimeout(resolve, 5))

    const resignResult = room.game.onAction(
      { name: 'alice', token: alice.token, role: 'white' },
      'resign',
      {},
    )
    room.dispatchEvents(resignResult.events)

    const over = store.records.find(r => r.type === 'game:over')!
    expect(typeof over.data.durationMs).toBe('number')
    expect(over.data.durationMs as number).toBeGreaterThan(0)
  })

  it('does not record event types other than the analytics set', async () => {
    const room = new GameRoom(new ChessGame())
    analytics.subscribe(room)

    const alice = await room.sessions.joinPlayer('alice')
    if (!alice.ok) throw new Error('join failed')
    // player:joined and lobby:update fire here — but we only record game:* / player:join.
    room.dispatchEvents(room.game.onPlayerJoin({ name: 'alice', token: alice.token, role: 'audience' }))

    expect(store.records.length).toBe(0)
  })
})
