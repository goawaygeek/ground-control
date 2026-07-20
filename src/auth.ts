import { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { PlayerStore } from './store.js'
import { sanitizeName } from './sanitize.js'

export type SessionState = 'connected' | 'lobby' | 'in-game'

export interface PlayerSession {
  name: string
  token: string
  role: string
  sseClients: Set<ServerResponse>
  disconnectTimer: NodeJS.Timeout | null
  /** Timestamp of last client liveness signal (SSE connect or /ping). */
  lastPingAt: number
  /**
   * Per docs/player-state.md:
   *   - 'connected': authenticated, on the server, not in any lobby roster.
   *     Reapable.
   *   - 'lobby': in the lobby roster, challengeable. Reapable.
   *   - 'in-game': actively in a game (id in gameInstanceId). Exempt from
   *     the liveness sweep (issue #8).
   */
  state: SessionState
  /** Set when state === 'in-game'; cleared on transition out. */
  gameInstanceId?: string
}

export type JoinResult = { ok: true; token: string; name: string; isReconnect: boolean } | { ok: false; error: string }

const DISCONNECT_GRACE_MS = 10_000

export class SessionManager {
  private sessions = new Map<string, PlayerSession>()    // token -> session
  private nameToToken = new Map<string, string>()         // name -> token

  constructor(private store?: PlayerStore) {}

  async joinPlayer(rawName: string): Promise<JoinResult> {
    // Sanitize BEFORE anything else: strip control chars and cap length so a
    // name can never carry a prompt-injection payload into other players'
    // sessions (names are shown inline, unwrapped, everywhere). See sanitize.ts.
    const name = sanitizeName(rawName).trim().toLowerCase()
    if (!name) return { ok: false, error: 'Name cannot be empty' }

    // If a store is configured, check if name is already registered there
    if (this.store) {
      const existing = await this.store.getByName(name)
      if (existing) {
        // Name exists in persistent store — check if they have an active session with SSE connections
        const activeSession = this.sessions.get(existing.token)
        if (activeSession && activeSession.sseClients.size > 0) {
          return { ok: false, error: `Name "${name}" is already taken` }
        }
        // Name is in store but no active SSE connections — they should use their token to reconnect
        // (This prevents someone from hijacking a disconnected player by just knowing their name)
        return { ok: false, error: `Name "${name}" is already registered. Use your token to reconnect.` }
      }
      // New name — create in store
      const record = await this.store.create(name)
      return this.createSession(record.token, record.name)
    }

    // No store — original in-memory behavior
    const existingToken = this.nameToToken.get(name)
    if (existingToken) {
      const existing = this.sessions.get(existingToken)!
      if (existing.sseClients.size === 0) {
        if (existing.disconnectTimer) {
          clearTimeout(existing.disconnectTimer)
          existing.disconnectTimer = null
        }
        return { ok: true, token: existingToken, name, isReconnect: true }
      }
      return { ok: false, error: `Name "${name}" is already taken` }
    }

    const token = randomUUID()
    return this.createSession(token, name)
  }

  async joinPlayerByToken(token: string): Promise<JoinResult> {
    if (!this.store) {
      return { ok: false, error: 'Token-based join requires a player store' }
    }

    const record = await this.store.getByToken(token)
    if (!record) {
      return { ok: false, error: 'Invalid token' }
    }

    // Check if already has an active session
    const existing = this.sessions.get(token)
    if (existing) {
      if (existing.disconnectTimer) {
        clearTimeout(existing.disconnectTimer)
        existing.disconnectTimer = null
      }
      return { ok: true, token, name: record.name, isReconnect: true }
    }

    // Restore session from store
    const session: PlayerSession = {
      name: record.name,
      token: record.token,
      role: 'audience',
      sseClients: new Set(),
      disconnectTimer: null,
      lastPingAt: Date.now(),
      state: 'connected',
    }
    this.sessions.set(token, session)
    this.nameToToken.set(record.name, token)

    return { ok: true, token, name: record.name, isReconnect: true }
  }

  private createSession(token: string, name: string): JoinResult {
    const session: PlayerSession = {
      name,
      token,
      role: 'audience',
      sseClients: new Set(),
      disconnectTimer: null,
      lastPingAt: Date.now(),
      state: 'connected',
    }
    this.sessions.set(token, session)
    this.nameToToken.set(name, token)

    return { ok: true, token, name, isReconnect: false }
  }

  authenticate(req: IncomingMessage): PlayerSession | null {
    const auth = req.headers['authorization']
    if (!auth?.startsWith('Bearer ')) return null
    return this.sessions.get(auth.slice(7)) ?? null
  }

  getSessionByToken(token: string): PlayerSession | null {
    return this.sessions.get(token) ?? null
  }

  getAllSessions(): PlayerSession[] {
    return [...this.sessions.values()]
  }

  getActiveSessions(): PlayerSession[] {
    return [...this.sessions.values()]
  }

  addSseClient(session: PlayerSession, res: ServerResponse): void {
    // Clear any pending disconnect timer
    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer)
      session.disconnectTimer = null
    }
    session.sseClients.add(res)
    session.lastPingAt = Date.now()
  }

  /** Update the liveness timestamp on a session — called from POST /<game>/ping. */
  markAlive(token: string): boolean {
    const session = this.sessions.get(token)
    if (!session) return false
    session.lastPingAt = Date.now()
    return true
  }

  removeSseClient(
    session: PlayerSession,
    res: ServerResponse,
    onDisconnect: (session: PlayerSession) => void,
  ): void {
    session.sseClients.delete(res)

    // In-game sessions are exempt from disconnect teardown, exactly as they
    // are exempt from the liveness sweep (getSessionsToReap). An MCP client
    // routinely drops and re-establishes its SSE connection mid-game; tearing
    // the game down on a 10s grace window was the real cause of the bot-reap
    // loop (the game would end, the session fell to 'connected', and the
    // sweep then reaped it). An in-game session survives a dropped SSE until
    // the client reconnects (reconnect-preserving-state) or the game's own
    // turn clock forfeits it. See docs/player-state.md (esp. line 240).
    if (session.state === 'in-game') return

    // If no more SSE connections, start grace period
    if (session.sseClients.size === 0) {
      session.disconnectTimer = setTimeout(() => {
        session.disconnectTimer = null
        onDisconnect(session)
      }, DISCONNECT_GRACE_MS)
    }
  }

  removePlayer(token: string): PlayerSession | null {
    const session = this.sessions.get(token)
    if (!session) return null

    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer)
    }

    this.sessions.delete(token)
    this.nameToToken.delete(session.name)
    return session
  }

  setRole(token: string, role: string): void {
    const session = this.sessions.get(token)
    if (session) session.role = role
  }

  /**
   * Transition a session to a new state. When entering 'in-game', the caller
   * MUST pass a gameInstanceId. When leaving 'in-game', the id is cleared.
   * For 'connected' or 'lobby' transitions, gameInstanceId is ignored (and
   * cleared if it was set).
   */
  setSessionState(token: string, state: SessionState, gameInstanceId?: string): void {
    const session = this.sessions.get(token)
    if (!session) return
    session.state = state
    if (state === 'in-game') {
      session.gameInstanceId = gameInstanceId
    } else {
      session.gameInstanceId = undefined
    }
  }

  /**
   * Returns sessions that should be cleaned up by the liveness sweep:
   * non-'in-game' sessions whose lastPingAt is older than the timeout.
   * In-game sessions are exempt — see issue #8 and docs/player-state.md.
   */
  getSessionsToReap(now: number, timeoutMs: number): PlayerSession[] {
    const stale: PlayerSession[] = []
    for (const session of this.sessions.values()) {
      if (session.state === 'in-game') continue
      if (now - session.lastPingAt > timeoutMs) {
        stale.push(session)
      }
    }
    return stale
  }

  /** Per-state count, used by /stats. */
  getSessionCountsByState(): Record<SessionState, number> {
    const counts: Record<SessionState, number> = { connected: 0, lobby: 0, 'in-game': 0 }
    for (const session of this.sessions.values()) {
      counts[session.state]++
    }
    return counts
  }
}

// Default instance + module-level functions for backward compatibility
const defaultManager = new SessionManager()

export const joinPlayer = (name: string) => defaultManager.joinPlayer(name)
export const joinPlayerByToken = (token: string) => defaultManager.joinPlayerByToken(token)
export const authenticate = defaultManager.authenticate.bind(defaultManager)
export const getSessionByToken = defaultManager.getSessionByToken.bind(defaultManager)
export const getAllSessions = defaultManager.getAllSessions.bind(defaultManager)
export const getActiveSessions = defaultManager.getActiveSessions.bind(defaultManager)
export const addSseClient = defaultManager.addSseClient.bind(defaultManager)
export const removeSseClient = defaultManager.removeSseClient.bind(defaultManager)
export const removePlayer = defaultManager.removePlayer.bind(defaultManager)
export const setRole = defaultManager.setRole.bind(defaultManager)
export const markAlive = defaultManager.markAlive.bind(defaultManager)
