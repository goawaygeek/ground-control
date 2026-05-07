import { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { PlayerStore } from './store.js'

export interface PlayerSession {
  name: string
  token: string
  role: string
  sseClients: Set<ServerResponse>
  disconnectTimer: NodeJS.Timeout | null
}

export type JoinResult = { ok: true; token: string; name: string; isReconnect: boolean } | { ok: false; error: string }

const DISCONNECT_GRACE_MS = 10_000

export class SessionManager {
  private sessions = new Map<string, PlayerSession>()    // token -> session
  private nameToToken = new Map<string, string>()         // name -> token

  constructor(private store?: PlayerStore) {}

  async joinPlayer(rawName: string): Promise<JoinResult> {
    const name = rawName.trim().toLowerCase()
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
  }

  removeSseClient(
    session: PlayerSession,
    res: ServerResponse,
    onDisconnect: (session: PlayerSession) => void,
  ): void {
    session.sseClients.delete(res)

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
