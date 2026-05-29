import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ChannelClient } from './channel-client.js'

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  })
}

describe('ChannelClient', () => {
  let client: ChannelClient
  let onEvent: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onEvent = vi.fn()
    client = new ChannelClient('http://localhost:8087', onEvent)
  })

  describe('initial state', () => {
    it('starts unconfigured', () => {
      expect(client.isConfigured()).toBe(false)
    })

    it('has no player name', () => {
      expect(client.getPlayerName()).toBeNull()
    })

    it('getStatus shows unconfigured', () => {
      const status = client.getStatus()
      expect(status.configured).toBe(false)
    })
  })

  describe('setName', () => {
    it('joins the game server and becomes configured', async () => {
      const fetch = mockFetch(200, { token: 'abc-123', name: 'alice' })
      client = new ChannelClient('http://localhost:8087', onEvent, fetch)

      const result = await client.setName('alice')

      expect(result.ok).toBe(true)
      expect(client.isConfigured()).toBe(true)
      expect(client.getPlayerName()).toBe('alice')
      expect(fetch).toHaveBeenCalledWith('http://localhost:8087/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'alice' }),
      })
    })

    it('rejects empty names', async () => {
      const result = await client.setName('')
      expect(result).toEqual({ ok: false, error: expect.stringContaining('name') })
      expect(client.isConfigured()).toBe(false)
    })

    it('rejects whitespace-only names', async () => {
      const result = await client.setName('   ')
      expect(result).toEqual({ ok: false, error: expect.stringContaining('name') })
      expect(client.isConfigured()).toBe(false)
    })

    it('propagates server errors', async () => {
      const fetch = mockFetch(409, { error: 'Name already taken' })
      client = new ChannelClient('http://localhost:8087', onEvent, fetch)

      const result = await client.setName('alice')

      expect(result).toEqual({ ok: false, error: 'Name already taken' })
      expect(client.isConfigured()).toBe(false)
    })

    it('rejects second call after successful join', async () => {
      const fetch = mockFetch(200, { token: 'abc-123', name: 'alice' })
      client = new ChannelClient('http://localhost:8087', onEvent, fetch)

      await client.setName('alice')
      const result = await client.setName('bob')

      expect(result).toEqual({ ok: false, error: expect.stringContaining('Already') })
      expect(client.getPlayerName()).toBe('alice')
    })
  })

  describe('game actions when unconfigured', () => {
    it('action rejects', async () => {
      const result = await client.action('submit', { joke: 'funny joke' })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('set_name')
    })

    it('startRound rejects', async () => {
      const result = await client.startRound()
      expect(result.ok).toBe(false)
      expect(result.error).toContain('set_name')
    })
  })

  describe('game actions when configured', () => {
    let fetch: ReturnType<typeof vi.fn>

    beforeEach(async () => {
      fetch = mockFetch(200, { token: 'abc-123', name: 'alice' })
      client = new ChannelClient('http://localhost:8087', onEvent, fetch)
      await client.setName('alice')
      // Reset fetch mock for subsequent calls
      fetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('OK'),
      })
    })

    it('action posts to /action with action field', async () => {
      const result = await client.action('submit', { joke: 'Why did the chicken...' })
      expect(result).toEqual({ ok: true })
      expect(fetch).toHaveBeenLastCalledWith('http://localhost:8087/action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer abc-123',
        },
        body: JSON.stringify({ action: 'submit', joke: 'Why did the chicken...' }),
      })
    })

    it('action for vote posts correct payload', async () => {
      const result = await client.action('vote', { jokeNumber: 2 })
      expect(result).toEqual({ ok: true })
      expect(fetch).toHaveBeenLastCalledWith('http://localhost:8087/action', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'vote', jokeNumber: 2 }),
      }))
    })

    it('startRound posts to /start-round', async () => {
      const result = await client.startRound()
      expect(result).toEqual({ ok: true })
      expect(fetch).toHaveBeenLastCalledWith('http://localhost:8087/start-round', expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Authorization': 'Bearer abc-123' }),
      }))
    })

    it('getStatus shows configured state', () => {
      const status = client.getStatus()
      expect(status.configured).toBe(true)
      expect(status.player).toBe('alice')
      expect(status.serverUrl).toBe('http://localhost:8087')
    })
  })

  describe('custom event types', () => {
    it('accepts event types via constructor', () => {
      const fetch = mockFetch(200, { token: 'abc-123', name: 'alice' })
      const customTypes = ['move:made', 'board:state', 'game:over']
      const customClient = new ChannelClient('http://localhost:8087', onEvent, fetch, customTypes)
      expect(customClient).toBeDefined()
    })
  })

  describe('auto-rejoin on 401 (recovers from server restart)', () => {
    /**
     * After a server restart, the client still holds a valid token (Notion-backed),
     * but the new server instance has an empty in-memory session map. Authenticated
     * calls return 401. The client should silently call /join with the stored token
     * to restore the session, then retry the original request.
     */
    function mockResponse(status: number, body: unknown) {
      return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
      }
    }

    it('re-joins via /join with the stored token and retries the original request when /action returns 401', async () => {
      const fetch = vi.fn()
        // Initial setName call
        .mockResolvedValueOnce(mockResponse(200, { token: 'tok-1', name: 'alice' }))
        // Action returns 401 (server restarted, session map empty)
        .mockResolvedValueOnce(mockResponse(401, 'Unauthorized'))
        // Recovery: /join with stored token succeeds
        .mockResolvedValueOnce(mockResponse(200, { token: 'tok-1', name: 'alice' }))
        // Retry of original action succeeds
        .mockResolvedValueOnce(mockResponse(200, { ok: true }))

      const client = new ChannelClient('http://localhost:8087', onEvent, fetch)
      await client.setName('alice')

      const result = await client.action('submit', { joke: 'why' })
      expect(result.ok).toBe(true)

      // 4 total fetches: setName join, failed action, recovery join, retry action
      expect(fetch).toHaveBeenCalledTimes(4)
      // The recovery /join used token-based body
      const recoveryCall = fetch.mock.calls[2]
      expect(recoveryCall[0]).toBe('http://localhost:8087/join')
      expect(JSON.parse(recoveryCall[1].body)).toEqual({ token: 'tok-1' })
    })

    it('does NOT retry indefinitely if the recovery /join also fails', async () => {
      const fetch = vi.fn()
        .mockResolvedValueOnce(mockResponse(200, { token: 'tok-1', name: 'alice' }))
        .mockResolvedValueOnce(mockResponse(401, 'Unauthorized'))
        // Recovery join itself fails
        .mockResolvedValueOnce(mockResponse(401, { error: 'Invalid token' }))

      const client = new ChannelClient('http://localhost:8087', onEvent, fetch)
      await client.setName('alice')

      const result = await client.action('submit', {})
      expect(result.ok).toBe(false)

      // Only 3 calls: setName, failed action, failed recovery join. No retry-of-retry.
      expect(fetch).toHaveBeenCalledTimes(3)
    })

    it('does not retry on non-401 errors', async () => {
      const fetch = vi.fn()
        .mockResolvedValueOnce(mockResponse(200, { token: 'tok-1', name: 'alice' }))
        // 400 — not an auth problem, no retry
        .mockResolvedValueOnce(mockResponse(400, { error: 'Bad request' }))

      const client = new ChannelClient('http://localhost:8087', onEvent, fetch)
      await client.setName('alice')

      const result = await client.action('submit', {})
      expect(result.ok).toBe(false)
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('does not loop forever if the retry itself returns 401', async () => {
      const fetch = vi.fn()
        .mockResolvedValueOnce(mockResponse(200, { token: 'tok-1', name: 'alice' }))
        .mockResolvedValueOnce(mockResponse(401, 'Unauthorized'))
        // Recovery join succeeds
        .mockResolvedValueOnce(mockResponse(200, { token: 'tok-1', name: 'alice' }))
        // Retried action returns 401 again — should give up, not loop
        .mockResolvedValueOnce(mockResponse(401, 'Still unauthorized'))

      const client = new ChannelClient('http://localhost:8087', onEvent, fetch)
      await client.setName('alice')

      const result = await client.action('submit', {})
      expect(result.ok).toBe(false)
      // Exactly 4 calls: setName, failed action, recovery join, retried action. No further attempts.
      expect(fetch).toHaveBeenCalledTimes(4)
    })
  })

  describe('pingOnce: surface server-side session loss to Claude', () => {
    /**
     * The ping loop runs in the background while the user is idle. If the
     * server forgets us (restart, deploy, etc.), the next ping returns 401.
     * The client should auto-rejoin and emit an MCP notification so Claude
     * can tell the user something happened.
     */
    function mockResponse(status: number, body: unknown = '') {
      return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
      }
    }

    it('does nothing when the ping returns 200', async () => {
      const fetch = vi.fn()
        .mockResolvedValueOnce(mockResponse(200, { token: 'tok-1', name: 'alice' }))
        .mockResolvedValueOnce(mockResponse(200))

      const client = new ChannelClient('http://localhost:8087', onEvent, fetch)
      await client.setName('alice')

      const onEventCallsBefore = onEvent.mock.calls.length
      await client.pingOnce()

      expect(fetch).toHaveBeenLastCalledWith('http://localhost:8087/ping', expect.any(Object))
      // No extra events emitted on a successful ping
      expect(onEvent.mock.calls.length).toBe(onEventCallsBefore)
    })

    it('auto-rejoins and emits system:session-reset when ping returns 401 after liveness was established', async () => {
      const fetch = vi.fn()
        .mockResolvedValueOnce(mockResponse(200, { token: 'tok-1', name: 'alice' }))
        // first ping → 200 (establishes liveness)
        .mockResolvedValueOnce(mockResponse(200))
        // second ping → 401 (real session loss)
        .mockResolvedValueOnce(mockResponse(401, 'Unauthorized'))
        // recovery join succeeds
        .mockResolvedValueOnce(mockResponse(200, { token: 'tok-1', name: 'alice' }))

      const client = new ChannelClient('http://localhost:8087', onEvent, fetch)
      await client.setName('alice')
      await client.pingOnce() // establishes liveness silently

      onEvent.mockClear()
      await client.pingOnce()

      const urls = fetch.mock.calls.map(c => c[0])
      expect(urls).toContain('http://localhost:8087/ping')
      expect(urls.filter(u => u === 'http://localhost:8087/join').length).toBeGreaterThanOrEqual(1)

      expect(onEvent).toHaveBeenCalledWith('system:session-reset', expect.any(String))
    })

    it('emits system:session-lost when recovery join also fails (after liveness was established)', async () => {
      const fetch = vi.fn()
        .mockResolvedValueOnce(mockResponse(200, { token: 'tok-1', name: 'alice' }))
        // first ping → 200 (establishes liveness)
        .mockResolvedValueOnce(mockResponse(200))
        // second ping → 401
        .mockResolvedValueOnce(mockResponse(401, 'Unauthorized'))
        // recovery join also fails
        .mockResolvedValueOnce(mockResponse(401, { error: 'Invalid token' }))

      const client = new ChannelClient('http://localhost:8087', onEvent, fetch)
      await client.setName('alice')
      await client.pingOnce()

      onEvent.mockClear()
      await client.pingOnce()

      expect(onEvent).toHaveBeenCalledWith('system:session-lost', expect.any(String))
    })

    it('does not emit notifications when the ping just has a transient network error', async () => {
      const fetch = vi.fn()
        .mockResolvedValueOnce(mockResponse(200, { token: 'tok-1', name: 'alice' }))
        .mockRejectedValueOnce(new Error('ECONNRESET'))

      const client = new ChannelClient('http://localhost:8087', onEvent, fetch)
      await client.setName('alice')

      onEvent.mockClear()
      await client.pingOnce()  // should not throw

      // No notification — single transient errors are not a session loss
      expect(onEvent).not.toHaveBeenCalledWith(
        expect.stringMatching(/^system:/),
        expect.any(String),
      )
    })

    it('pingOnce is a no-op when not configured', async () => {
      const fetch = vi.fn()
      const client = new ChannelClient('http://localhost:8087', onEvent, fetch)
      // Never called setName
      await client.pingOnce()
      expect(fetch).not.toHaveBeenCalled()
    })

    // A freshly-spawned MCP server process holds a token from .env but never
    // saw a successful ping against the current server-side session map. If
    // the very first ping returns 401, that's a normal startup handshake —
    // the server didn't restart, this client process did. Don't notify Claude;
    // just silently rejoin. See PR #14 follow-up.
    it('does NOT emit a session-reset notification on the very first ping returning 401', async () => {
      const fetch = vi.fn()
        .mockResolvedValueOnce(mockResponse(200, { token: 'tok-1', name: 'alice' }))
        // first ping → 401
        .mockResolvedValueOnce(mockResponse(401, 'Unauthorized'))
        // silent recovery /join
        .mockResolvedValueOnce(mockResponse(200, { token: 'tok-1', name: 'alice' }))

      const client = new ChannelClient('http://localhost:8087', onEvent, fetch)
      await client.setName('alice')
      onEvent.mockClear()

      await client.pingOnce()

      expect(onEvent).not.toHaveBeenCalledWith(
        expect.stringMatching(/^system:/),
        expect.any(String),
      )
    })

    it('DOES emit a session-reset notification on a 401 after a successful prior ping', async () => {
      const fetch = vi.fn()
        .mockResolvedValueOnce(mockResponse(200, { token: 'tok-1', name: 'alice' }))
        // first ping succeeds — establishes liveness in this process
        .mockResolvedValueOnce(mockResponse(200))
        // later ping → 401 (server actually lost us)
        .mockResolvedValueOnce(mockResponse(401, 'Unauthorized'))
        // recovery /join
        .mockResolvedValueOnce(mockResponse(200, { token: 'tok-1', name: 'alice' }))

      const client = new ChannelClient('http://localhost:8087', onEvent, fetch)
      await client.setName('alice')
      await client.pingOnce()      // 200 — sets the "liveness established" flag
      onEvent.mockClear()
      await client.pingOnce()      // 401 — this one IS noteworthy

      expect(onEvent).toHaveBeenCalledWith('system:session-reset', expect.any(String))
    })

    it('session-reset message does not assert that the server was restarted', async () => {
      const fetch = vi.fn()
        .mockResolvedValueOnce(mockResponse(200, { token: 'tok-1', name: 'alice' }))
        .mockResolvedValueOnce(mockResponse(200))
        .mockResolvedValueOnce(mockResponse(401, 'Unauthorized'))
        .mockResolvedValueOnce(mockResponse(200, { token: 'tok-1', name: 'alice' }))

      const client = new ChannelClient('http://localhost:8087', onEvent, fetch)
      await client.setName('alice')
      await client.pingOnce()
      onEvent.mockClear()
      await client.pingOnce()

      const call = onEvent.mock.calls.find(c => c[0] === 'system:session-reset')!
      const message = call[1] as string
      // Should describe what we observed, not a presumed cause.
      expect(message.toLowerCase()).not.toContain('restart')
      expect(message.toLowerCase()).not.toContain('server was')
    })
  })
})
