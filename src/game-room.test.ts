import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GameRoom } from './game-room.js'
import type { GameModule, GameEvent, PlayerInfo, ActionResult } from './game/types.js'

function createMockGame(gameId: string = 'test-game'): GameModule {
  return {
    gameId,
    getPhase: vi.fn(() => 'LOBBY'),
    getState: vi.fn(() => ({ phase: 'LOBBY' })),
    onPlayerJoin: vi.fn(() => []),
    onPlayerLeave: vi.fn(() => []),
    canStartGame: vi.fn(() => false),
    startRound: vi.fn(() => []),
    onAction: vi.fn(() => ({ ok: true, events: [] })),
    onPhaseTimeout: vi.fn(() => []),
    getTools: vi.fn(() => []),
    getInstructions: vi.fn(() => 'Test instructions'),
    getEventTypes: vi.fn(() => []),
    getRoleAssignments: vi.fn(() => new Map()),
    getConfig: vi.fn(() => ({})),
    setConfig: vi.fn(),
  }
}

function createMockRes(): any {
  return {
    write: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn(),
  }
}

describe('GameRoom', () => {
  describe('isolation', () => {
    it('two rooms have independent session stores', async () => {
      const room1 = new GameRoom(createMockGame('game-a'))
      const room2 = new GameRoom(createMockGame('game-b'))

      const r1 = await room1.sessions.joinPlayer('scott')
      const r2 = await room2.sessions.joinPlayer('scott')

      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)
      if (r1.ok && r2.ok) {
        expect(r1.token).not.toBe(r2.token)
      }
    })

    it('broadcasting in one room does not affect the other', async () => {
      const room1 = new GameRoom(createMockGame('game-a'))
      const room2 = new GameRoom(createMockGame('game-b'))

      // Add a player to each room
      const r1 = await room1.sessions.joinPlayer('alice')
      const r2 = await room2.sessions.joinPlayer('bob')
      if (!r1.ok || !r2.ok) throw new Error('join failed')

      const res1 = createMockRes()
      const res2 = createMockRes()
      room1.sessions.addSseClient(room1.sessions.getSessionByToken(r1.token)!, res1)
      room2.sessions.addSseClient(room2.sessions.getSessionByToken(r2.token)!, res2)

      // Broadcast to room1 only
      room1.broadcastToAllPlayers({ type: 'test', data: { msg: 'hello' } })

      expect(res1.write).toHaveBeenCalled()
      expect(res2.write).not.toHaveBeenCalled()
    })
  })

  describe('broadcastToPlayer', () => {
    it('sends SSE event to specific player', async () => {
      const room = new GameRoom(createMockGame())
      const result = await room.sessions.joinPlayer('alice')
      if (!result.ok) throw new Error('join failed')

      const res = createMockRes()
      room.sessions.addSseClient(room.sessions.getSessionByToken(result.token)!, res)

      room.broadcastToPlayer(result.token, { type: 'greeting', data: { msg: 'hi' } })

      expect(res.write).toHaveBeenCalledWith(
        expect.stringContaining('event: greeting'),
        expect.any(Function),
      )
      expect(res.write).toHaveBeenCalledWith(
        expect.stringContaining('"msg":"hi"'),
        expect.any(Function),
      )
    })
  })

  describe('broadcastToAudience', () => {
    it('sends SSE event to audience clients only', async () => {
      const room = new GameRoom(createMockGame())
      const audienceRes = createMockRes()
      room.audienceClients.add(audienceRes)

      // Add a player too
      const result = await room.sessions.joinPlayer('alice')
      if (!result.ok) throw new Error('join failed')
      const playerRes = createMockRes()
      room.sessions.addSseClient(room.sessions.getSessionByToken(result.token)!, playerRes)

      room.broadcastToAudience({ type: 'score', data: { points: 10 } })

      expect(audienceRes.write).toHaveBeenCalled()
      expect(playerRes.write).not.toHaveBeenCalled()
    })
  })

  describe('broadcastEverywhere', () => {
    it('sends to both players and audience', async () => {
      const room = new GameRoom(createMockGame())
      const audienceRes = createMockRes()
      room.audienceClients.add(audienceRes)

      const result = await room.sessions.joinPlayer('alice')
      if (!result.ok) throw new Error('join failed')
      const playerRes = createMockRes()
      room.sessions.addSseClient(room.sessions.getSessionByToken(result.token)!, playerRes)

      room.broadcastEverywhere({ type: 'announcement', data: {} })

      expect(audienceRes.write).toHaveBeenCalled()
      expect(playerRes.write).toHaveBeenCalled()
    })
  })

  describe('dispatchEvents', () => {
    it('sends targeted events only to the specified player', async () => {
      const room = new GameRoom(createMockGame())

      const r1 = await room.sessions.joinPlayer('alice')
      const r2 = await room.sessions.joinPlayer('bob')
      if (!r1.ok || !r2.ok) throw new Error('join failed')

      const res1 = createMockRes()
      const res2 = createMockRes()
      room.sessions.addSseClient(room.sessions.getSessionByToken(r1.token)!, res1)
      room.sessions.addSseClient(room.sessions.getSessionByToken(r2.token)!, res2)

      const events: GameEvent[] = [
        { type: 'secret', data: { info: 'only for alice' }, _targetPlayer: r1.token }
      ]
      room.dispatchEvents(events)

      expect(res1.write).toHaveBeenCalled()
      expect(res2.write).not.toHaveBeenCalled()
    })

    it('broadcasts non-targeted events to everyone', async () => {
      const room = new GameRoom(createMockGame())

      const r1 = await room.sessions.joinPlayer('alice')
      if (!r1.ok) throw new Error('join failed')

      const playerRes = createMockRes()
      room.sessions.addSseClient(room.sessions.getSessionByToken(r1.token)!, playerRes)

      const audienceRes = createMockRes()
      room.audienceClients.add(audienceRes)

      room.dispatchEvents([{ type: 'update', data: {} }])

      expect(playerRes.write).toHaveBeenCalled()
      expect(audienceRes.write).toHaveBeenCalled()
    })

    it('sets phase timer when event has _nextPhaseTimeout', () => {
      vi.useFakeTimers()
      const mockGame = createMockGame()
      ;(mockGame.onPhaseTimeout as any).mockReturnValue([])
      const room = new GameRoom(mockGame)

      room.dispatchEvents([{ type: 'phase', data: {}, _nextPhaseTimeout: 5000 }])

      vi.advanceTimersByTime(5000)
      expect(mockGame.onPhaseTimeout).toHaveBeenCalled()

      vi.useRealTimers()
    })

    it('clears previous phase timer when new one is set', () => {
      vi.useFakeTimers()
      const mockGame = createMockGame()
      ;(mockGame.onPhaseTimeout as any).mockReturnValue([])
      const room = new GameRoom(mockGame)

      room.dispatchEvents([{ type: 'phase1', data: {}, _nextPhaseTimeout: 5000 }])
      room.dispatchEvents([{ type: 'phase2', data: {}, _nextPhaseTimeout: 3000 }])

      vi.advanceTimersByTime(5000)
      // Should only have been called once (from the second timer at 3000ms)
      expect(mockGame.onPhaseTimeout).toHaveBeenCalledTimes(1)

      vi.useRealTimers()
    })

    it('maintains independent timers with different _phaseTimerKey values', () => {
      vi.useFakeTimers()
      const mockGame = createMockGame()
      ;(mockGame.onPhaseTimeout as any).mockReturnValue([])
      const room = new GameRoom(mockGame)

      room.dispatchEvents([{ type: 'timer-a', data: {}, _nextPhaseTimeout: 5000, _phaseTimerKey: 'game-1' }])
      room.dispatchEvents([{ type: 'timer-b', data: {}, _nextPhaseTimeout: 3000, _phaseTimerKey: 'game-2' }])

      // At 3000ms, only game-2 timer fires
      vi.advanceTimersByTime(3000)
      expect(mockGame.onPhaseTimeout).toHaveBeenCalledTimes(1)
      expect(mockGame.onPhaseTimeout).toHaveBeenCalledWith('game-2')

      // At 5000ms, game-1 timer fires
      vi.advanceTimersByTime(2000)
      expect(mockGame.onPhaseTimeout).toHaveBeenCalledTimes(2)
      expect(mockGame.onPhaseTimeout).toHaveBeenCalledWith('game-1')

      vi.useRealTimers()
    })

    it('replacing a keyed timer only clears that key, not others', () => {
      vi.useFakeTimers()
      const mockGame = createMockGame()
      ;(mockGame.onPhaseTimeout as any).mockReturnValue([])
      const room = new GameRoom(mockGame)

      room.dispatchEvents([{ type: 'a', data: {}, _nextPhaseTimeout: 5000, _phaseTimerKey: 'game-1' }])
      room.dispatchEvents([{ type: 'b', data: {}, _nextPhaseTimeout: 5000, _phaseTimerKey: 'game-2' }])

      // Replace game-1 timer with a shorter one
      room.dispatchEvents([{ type: 'c', data: {}, _nextPhaseTimeout: 2000, _phaseTimerKey: 'game-1' }])

      vi.advanceTimersByTime(2000)
      expect(mockGame.onPhaseTimeout).toHaveBeenCalledTimes(1)
      expect(mockGame.onPhaseTimeout).toHaveBeenCalledWith('game-1')

      // game-2 still fires at 5000ms
      vi.advanceTimersByTime(3000)
      expect(mockGame.onPhaseTimeout).toHaveBeenCalledTimes(2)
      expect(mockGame.onPhaseTimeout).toHaveBeenCalledWith('game-2')

      vi.useRealTimers()
    })

    it('events without _phaseTimerKey use default key (backward compat)', () => {
      vi.useFakeTimers()
      const mockGame = createMockGame()
      ;(mockGame.onPhaseTimeout as any).mockReturnValue([])
      const room = new GameRoom(mockGame)

      room.dispatchEvents([{ type: 'phase', data: {}, _nextPhaseTimeout: 5000 }])

      vi.advanceTimersByTime(5000)
      expect(mockGame.onPhaseTimeout).toHaveBeenCalledTimes(1)
      expect(mockGame.onPhaseTimeout).toHaveBeenCalledWith('default')

      vi.useRealTimers()
    })
  })

  describe('onEvent listeners', () => {
    it('fires for broadcast (non-targeted) events with roomId attached', () => {
      const room = new GameRoom(createMockGame('chess'))
      const listener = vi.fn()
      room.onEvent(listener)

      room.dispatchEvents([{ type: 'lobby:update', data: { foo: 1 } }])

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith({
        type: 'lobby:update',
        data: { foo: 1 },
        _targetPlayer: undefined,
        roomId: 'chess',
      })
    })

    it('fires for targeted events and surfaces _targetPlayer', () => {
      const room = new GameRoom(createMockGame('chess'))
      const listener = vi.fn()
      room.onEvent(listener)

      room.dispatchEvents([{
        type: 'challenge:received',
        data: { challengeId: 'x' },
        _targetPlayer: 'tok-123',
      }])

      expect(listener).toHaveBeenCalledTimes(1)
      const call = listener.mock.calls[0][0]
      expect(call.type).toBe('challenge:received')
      expect(call._targetPlayer).toBe('tok-123')
    })

    it('returns an unsubscribe function that stops further calls', () => {
      const room = new GameRoom(createMockGame())
      const listener = vi.fn()
      const unsubscribe = room.onEvent(listener)

      room.dispatchEvents([{ type: 'a', data: {} }])
      unsubscribe()
      room.dispatchEvents([{ type: 'b', data: {} }])

      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('continues invoking remaining listeners when one throws', () => {
      const room = new GameRoom(createMockGame())
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const bad = vi.fn(() => { throw new Error('boom') })
      const good = vi.fn()
      room.onEvent(bad)
      room.onEvent(good)

      room.dispatchEvents([{ type: 'a', data: {} }])

      expect(bad).toHaveBeenCalled()
      expect(good).toHaveBeenCalled()
      expect(errSpy).toHaveBeenCalled()
      errSpy.mockRestore()
    })

    it('does not block broadcast when a listener throws', async () => {
      const room = new GameRoom(createMockGame())
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const r = await room.sessions.joinPlayer('alice')
      if (!r.ok) throw new Error('join failed')
      const res = createMockRes()
      room.sessions.addSseClient(room.sessions.getSessionByToken(r.token)!, res)
      room.onEvent(() => { throw new Error('boom') })

      room.dispatchEvents([{ type: 'a', data: {} }])

      expect(res.write).toHaveBeenCalled()
      errSpy.mockRestore()
    })
  })

  describe('tryAutoStart', () => {
    it('starts the game when canStartGame returns true', async () => {
      const mockGame = createMockGame()
      ;(mockGame.canStartGame as any).mockReturnValue(true)
      ;(mockGame.startRound as any).mockReturnValue([{ type: 'round:start', data: {} }])
      ;(mockGame.getRoleAssignments as any).mockReturnValue(new Map())

      const room = new GameRoom(mockGame)
      const r1 = await room.sessions.joinPlayer('alice')
      if (!r1.ok) throw new Error('join failed')

      room.tryAutoStart()

      expect(mockGame.startRound).toHaveBeenCalled()
    })

    it('does not start when canStartGame returns false', () => {
      const mockGame = createMockGame()
      const room = new GameRoom(mockGame)

      room.tryAutoStart()

      expect(mockGame.startRound).not.toHaveBeenCalled()
    })
  })

  describe('handleMessage', () => {
    it('broadcasts player:message to all players and audience', async () => {
      const room = new GameRoom(createMockGame())

      const r1 = await room.sessions.joinPlayer('alice')
      const r2 = await room.sessions.joinPlayer('bob')
      if (!r1.ok || !r2.ok) throw new Error('join failed')

      const res1 = createMockRes()
      const res2 = createMockRes()
      const audienceRes = createMockRes()
      room.sessions.addSseClient(room.sessions.getSessionByToken(r1.token)!, res1)
      room.sessions.addSseClient(room.sessions.getSessionByToken(r2.token)!, res2)
      room.audienceClients.add(audienceRes)

      room.handleMessage(
        { name: 'alice', token: r1.token, role: 'audience' },
        'Hello Bob!'
      )

      // All three should receive the message
      for (const res of [res1, res2, audienceRes]) {
        expect(res.write).toHaveBeenCalledWith(
          expect.stringContaining('player:message'),
          expect.any(Function),
        )
        expect(res.write).toHaveBeenCalledWith(
          expect.stringContaining('Hello Bob!'),
          expect.any(Function),
        )
        expect(res.write).toHaveBeenCalledWith(
          expect.stringContaining('alice'),
          expect.any(Function),
        )
      }
    })

    it('includes from and message fields in the event data', async () => {
      const room = new GameRoom(createMockGame())
      const r1 = await room.sessions.joinPlayer('alice')
      if (!r1.ok) throw new Error('join failed')

      const res = createMockRes()
      room.sessions.addSseClient(room.sessions.getSessionByToken(r1.token)!, res)

      room.handleMessage(
        { name: 'alice', token: r1.token, role: 'audience' },
        'GG!'
      )

      const written = res.write.mock.calls[0][0] as string
      const dataLine = written.split('\n').find((l: string) => l.startsWith('data: '))!
      const parsed = JSON.parse(dataLine.replace('data: ', ''))

      expect(parsed.from).toBe('alice')
      expect(parsed.message).toBe('GG!')
      expect(parsed.timestamp).toBeDefined()
    })
  })

  describe('clearPhaseTimer', () => {
    it('clears any active phase timer', () => {
      vi.useFakeTimers()
      const mockGame = createMockGame()
      ;(mockGame.onPhaseTimeout as any).mockReturnValue([])
      const room = new GameRoom(mockGame)

      room.dispatchEvents([{ type: 'phase', data: {}, _nextPhaseTimeout: 5000 }])
      room.clearPhaseTimer()

      vi.advanceTimersByTime(5000)
      expect(mockGame.onPhaseTimeout).not.toHaveBeenCalled()

      vi.useRealTimers()
    })
  })
})
