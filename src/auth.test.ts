import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SessionManager } from './auth.js'
import { LocalJsonStore } from './store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('SessionManager', () => {
  describe('joinPlayer', () => {
    it('creates a session with default role "audience"', async () => {
      const sm = new SessionManager()
      const result = await sm.joinPlayer('alice')
      expect(result.ok).toBe(true)
      if (result.ok) {
        const session = sm.getSessionByToken(result.token)
        expect(session).toBeDefined()
        expect(session!.role).toBe('audience')
        expect(session!.name).toBe('alice')
      }
    })

    it('rejects empty name', async () => {
      const sm = new SessionManager()
      const result = await sm.joinPlayer('')
      expect(result.ok).toBe(false)
    })

    it('normalizes name to lowercase trimmed', async () => {
      const sm = new SessionManager()
      const result = await sm.joinPlayer('  Alice  ')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(sm.getSessionByToken(result.token)!.name).toBe('alice')
      }
    })

    it('rejects duplicate name when active SSE connection exists', async () => {
      const sm = new SessionManager()
      const r1 = await sm.joinPlayer('bob')
      expect(r1.ok).toBe(true)
      if (r1.ok) {
        // Simulate an active SSE connection
        const fakeRes = {} as any
        sm.addSseClient(sm.getSessionByToken(r1.token)!, fakeRes)
      }
      const r2 = await sm.joinPlayer('bob')
      expect(r2.ok).toBe(false)
    })

    it('allows reconnect when no active SSE connections', async () => {
      const sm = new SessionManager()
      const r1 = await sm.joinPlayer('carol')
      expect(r1.ok).toBe(true)
      // No SSE clients added, so reconnect should work
      const r2 = await sm.joinPlayer('carol')
      expect(r2.ok).toBe(true)
      if (r2.ok) {
        expect(r2.isReconnect).toBe(true)
      }
    })
  })

  describe('instance isolation', () => {
    it('two instances can have the same player name with different tokens', async () => {
      const sm1 = new SessionManager()
      const sm2 = new SessionManager()

      const r1 = await sm1.joinPlayer('scott')
      const r2 = await sm2.joinPlayer('scott')

      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)
      if (r1.ok && r2.ok) {
        expect(r1.token).not.toBe(r2.token)
        expect(sm1.getSessionByToken(r1.token)).toBeDefined()
        expect(sm1.getSessionByToken(r2.token)).toBeNull()
        expect(sm2.getSessionByToken(r2.token)).toBeDefined()
        expect(sm2.getSessionByToken(r1.token)).toBeNull()
      }
    })

    it('removing a player from one instance does not affect the other', async () => {
      const sm1 = new SessionManager()
      const sm2 = new SessionManager()

      const r1 = await sm1.joinPlayer('dave')
      const r2 = await sm2.joinPlayer('dave')
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)

      if (r1.ok && r2.ok) {
        sm1.removePlayer(r1.token)
        expect(sm1.getSessionByToken(r1.token)).toBeNull()
        expect(sm2.getSessionByToken(r2.token)).toBeDefined()
      }
    })
  })

  describe('setRole', () => {
    it('accepts arbitrary string roles', async () => {
      const sm = new SessionManager()
      const result = await sm.joinPlayer('eve')
      if (!result.ok) throw new Error('join failed')

      sm.setRole(result.token, 'white')
      expect(sm.getSessionByToken(result.token)!.role).toBe('white')

      sm.setRole(result.token, 'black')
      expect(sm.getSessionByToken(result.token)!.role).toBe('black')
    })
  })

  describe('getAllSessions / getActiveSessions', () => {
    it('returns all sessions in the instance', async () => {
      const sm = new SessionManager()
      await sm.joinPlayer('a')
      await sm.joinPlayer('b')
      expect(sm.getAllSessions()).toHaveLength(2)
      expect(sm.getActiveSessions()).toHaveLength(2)
    })
  })

  describe('session state (connected / lobby / in-game)', () => {
    it('new sessions start in the connected state, not lobby (per spec)', async () => {
      const sm = new SessionManager()
      const r = await sm.joinPlayer('alice')
      if (!r.ok) throw new Error('join failed')
      expect(sm.getSessionByToken(r.token)!.state).toBe('connected')
    })

    it('new sessions have no gameInstanceId until they enter a game', async () => {
      const sm = new SessionManager()
      const r = await sm.joinPlayer('alice')
      if (!r.ok) throw new Error('join failed')
      expect(sm.getSessionByToken(r.token)!.gameInstanceId).toBeUndefined()
    })

    it('setSessionState transitions through connected → lobby → in-game → connected', async () => {
      const sm = new SessionManager()
      const r = await sm.joinPlayer('alice')
      if (!r.ok) throw new Error('join failed')

      sm.setSessionState(r.token, 'lobby')
      expect(sm.getSessionByToken(r.token)!.state).toBe('lobby')

      sm.setSessionState(r.token, 'in-game', 'game-abc')
      expect(sm.getSessionByToken(r.token)!.state).toBe('in-game')
      expect(sm.getSessionByToken(r.token)!.gameInstanceId).toBe('game-abc')

      sm.setSessionState(r.token, 'connected')
      expect(sm.getSessionByToken(r.token)!.state).toBe('connected')
      // gameInstanceId is cleared when transitioning out of in-game
      expect(sm.getSessionByToken(r.token)!.gameInstanceId).toBeUndefined()
    })

    it('setSessionState is a no-op for unknown tokens', () => {
      const sm = new SessionManager()
      // Should not throw.
      sm.setSessionState('nonexistent-token', 'in-game')
    })
  })

  describe('getSessionsToReap', () => {
    it('reaps connected sessions whose lastPingAt is older than the timeout', async () => {
      const sm = new SessionManager()
      const r = await sm.joinPlayer('alice')
      if (!r.ok) throw new Error('join failed')
      // Default state is 'connected' per the new model.

      const session = sm.getSessionByToken(r.token)!
      session.lastPingAt = 1000

      const toReap = sm.getSessionsToReap(/* now */ 100_000, /* timeoutMs */ 90_000)
      expect(toReap.map(s => s.name)).toEqual(['alice'])
    })

    it('reaps lobby sessions whose lastPingAt is older than the timeout', async () => {
      const sm = new SessionManager()
      const r = await sm.joinPlayer('alice')
      if (!r.ok) throw new Error('join failed')

      sm.setSessionState(r.token, 'lobby')
      sm.getSessionByToken(r.token)!.lastPingAt = 1000

      const toReap = sm.getSessionsToReap(100_000, 90_000)
      expect(toReap.map(s => s.name)).toEqual(['alice'])
    })

    it('does NOT reap sessions whose lastPingAt is within the timeout', async () => {
      const sm = new SessionManager()
      const r = await sm.joinPlayer('alice')
      if (!r.ok) throw new Error('join failed')

      sm.getSessionByToken(r.token)!.lastPingAt = 50_000

      const toReap = sm.getSessionsToReap(100_000, 90_000)
      expect(toReap).toHaveLength(0)
    })

    it('does NOT reap in-game sessions even if they have stopped pinging entirely', async () => {
      const sm = new SessionManager()
      const r = await sm.joinPlayer('alice')
      if (!r.ok) throw new Error('join failed')

      sm.setSessionState(r.token, 'in-game', 'game-abc')
      sm.getSessionByToken(r.token)!.lastPingAt = 0

      const toReap = sm.getSessionsToReap(100_000, 90_000)
      expect(toReap).toHaveLength(0)
    })

    it('reaps a player who returned to connected after a game and went silent', async () => {
      const sm = new SessionManager()
      const r = await sm.joinPlayer('alice')
      if (!r.ok) throw new Error('join failed')

      sm.setSessionState(r.token, 'in-game', 'game-abc')
      sm.getSessionByToken(r.token)!.lastPingAt = 0
      expect(sm.getSessionsToReap(100_000, 90_000)).toHaveLength(0)

      // Game ends — back to connected.
      sm.setSessionState(r.token, 'connected')
      expect(sm.getSessionsToReap(100_000, 90_000).map(s => s.name)).toEqual(['alice'])
    })

    it('returns multiple sessions when several are stale (connected or lobby)', async () => {
      const sm = new SessionManager()
      for (const name of ['a', 'b', 'c']) {
        const r = await sm.joinPlayer(name)
        if (!r.ok) throw new Error('join failed')
        sm.getSessionByToken(r.token)!.lastPingAt = 0
      }
      const toReap = sm.getSessionsToReap(100_000, 90_000)
      expect(toReap.map(s => s.name).sort()).toEqual(['a', 'b', 'c'])
    })
  })

  describe('getSessionCountsByState', () => {
    it('reports zero counts when no sessions exist', () => {
      const sm = new SessionManager()
      expect(sm.getSessionCountsByState()).toEqual({ connected: 0, lobby: 0, 'in-game': 0 })
    })

    it('counts each session in its current state', async () => {
      const sm = new SessionManager()
      const a = await sm.joinPlayer('a'); if (!a.ok) throw new Error('a')
      const b = await sm.joinPlayer('b'); if (!b.ok) throw new Error('b')
      const c = await sm.joinPlayer('c'); if (!c.ok) throw new Error('c')
      const d = await sm.joinPlayer('d'); if (!d.ok) throw new Error('d')

      // a: stays connected
      sm.setSessionState(b.token, 'lobby')
      sm.setSessionState(c.token, 'lobby')
      sm.setSessionState(d.token, 'in-game', 'g1')

      expect(sm.getSessionCountsByState()).toEqual({
        connected: 1,
        lobby: 2,
        'in-game': 1,
      })
    })
  })

  describe('joinPlayer with PlayerStore', () => {
    let dir: string
    let store: LocalJsonStore

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'gsl-auth-test-'))
      store = new LocalJsonStore(join(dir, 'players.json'))
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('creates a new player in the store when joining by name', async () => {
      const sm = new SessionManager(store)
      const result = await sm.joinPlayer('alice')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(store.getByToken(result.token)).not.toBeNull()
        expect(store.getByName('alice')).not.toBeNull()
      }
    })

    it('reconnects with a persistent token', async () => {
      const sm = new SessionManager(store)
      const r1 = await sm.joinPlayer('alice')
      if (!r1.ok) throw new Error('join failed')

      // Simulate server restart: new SessionManager, same store
      const sm2 = new SessionManager(store)
      const r2 = await sm2.joinPlayerByToken(r1.token)
      expect(r2.ok).toBe(true)
      if (r2.ok) {
        expect(r2.name).toBe('alice')
        expect(r2.token).toBe(r1.token)
        expect(r2.isReconnect).toBe(true)
      }
    })

    it('rejects unknown token', async () => {
      const sm = new SessionManager(store)
      const result = await sm.joinPlayerByToken('nonexistent-token')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('Invalid token')
      }
    })

    it('rejects name that already exists in the store', async () => {
      store.create('bob')
      const sm = new SessionManager(store)
      const result = await sm.joinPlayer('bob')
      // Should succeed as a reconnect (they know the name)
      // But without a token, we need to give them the token back
      // Actually: name-only join should fail if name is in store but no active session
      // The player should use their token to reconnect
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('already registered')
      }
    })

    it('token reconnect restores the session in the manager', async () => {
      const sm = new SessionManager(store)
      const r1 = await sm.joinPlayer('carol')
      if (!r1.ok) throw new Error('join failed')

      // New manager, same store
      const sm2 = new SessionManager(store)
      const r2 = await sm2.joinPlayerByToken(r1.token)
      expect(r2.ok).toBe(true)
      if (r2.ok) {
        const session = sm2.getSessionByToken(r2.token)
        expect(session).not.toBeNull()
        expect(session!.name).toBe('carol')
      }
    })
  })

  describe('authenticate', () => {
    it('returns session for valid Bearer token', async () => {
      const sm = new SessionManager()
      const result = await sm.joinPlayer('frank')
      if (!result.ok) throw new Error('join failed')

      const fakeReq = { headers: { authorization: `Bearer ${result.token}` } } as any
      expect(sm.authenticate(fakeReq)).toBeDefined()
      expect(sm.authenticate(fakeReq)!.name).toBe('frank')
    })

    it('returns null for missing/invalid auth header', () => {
      const sm = new SessionManager()
      expect(sm.authenticate({ headers: {} } as any)).toBeNull()
      expect(sm.authenticate({ headers: { authorization: 'Basic abc' } } as any)).toBeNull()
    })
  })
})
