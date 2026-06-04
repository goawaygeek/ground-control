import { ServerResponse } from 'node:http'
import { SessionManager } from './auth.js'
import type { GameModule, GameEvent, PlayerInfo } from './game/types.js'
import type { PlayerStore } from './store.js'

export type RoomEventListener = (event: {
  type: string
  data: unknown
  _targetPlayer?: string
  roomId: string
}) => void

export type StateTransitionListener = (transition: {
  roomId: string
  token: string
  name: string
  from: 'connected' | 'lobby' | 'in-game'
  to: 'connected' | 'lobby' | 'in-game'
  gameInstanceId?: string
}) => void

export class GameRoom {
  readonly game: GameModule
  readonly sessions: SessionManager
  readonly audienceClients = new Set<ServerResponse>()
  private phaseTimers = new Map<string, NodeJS.Timeout>()
  private eventListeners = new Set<RoomEventListener>()
  private stateTransitionListeners = new Set<StateTransitionListener>()

  constructor(game: GameModule, store?: PlayerStore) {
    this.game = game
    this.sessions = new SessionManager(store)
  }

  onEvent(listener: RoomEventListener): () => void {
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }

  /**
   * Subscribe to session-state transitions (connected/lobby/in-game). Fires
   * whenever a session:state event is dispatched. Used by analytics to record
   * the funnel of how players engage. See docs/player-state.md.
   */
  onStateTransition(listener: StateTransitionListener): () => void {
    this.stateTransitionListeners.add(listener)
    return () => { this.stateTransitionListeners.delete(listener) }
  }

  // Write to an SSE client, force-closing the connection on any failure so
  // our cleanup handlers fire and the player gets removed from the room.
  // Catches half-open connections Cloud Run held after the client went away.
  private safeWrite(client: ServerResponse, payload: string): void {
    try {
      if (client.destroyed || client.writableEnded) {
        client.end()
        return
      }
      client.write(payload, (err) => {
        if (err) client.end()
      })
    } catch {
      try { client.end() } catch { /* swallow */ }
    }
  }

  broadcastToPlayer(token: string, event: { type: string; data: unknown }): void {
    const session = this.sessions.getSessionByToken(token)
    if (!session) return
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`
    for (const res of session.sseClients) {
      this.safeWrite(res, payload)
    }
  }

  broadcastToAllPlayers(event: { type: string; data: unknown }): void {
    for (const session of this.sessions.getActiveSessions()) {
      this.broadcastToPlayer(session.token, event)
    }
  }

  broadcastToAudience(event: { type: string; data: unknown }): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`
    for (const res of this.audienceClients) {
      this.safeWrite(res, payload)
    }
  }

  broadcastEverywhere(event: { type: string; data: unknown }): void {
    this.broadcastToAllPlayers(event)
    this.broadcastToAudience(event)
  }

  dispatchEvents(events: GameEvent[]): void {
    for (const event of events) {
      const {
        _nextPhaseTimeout,
        _targetPlayer,
        _phaseTimerKey,
        _sessionState,
        _sessionStateToken,
        _sessionStateGameInstanceId,
        ...broadcastable
      } = event

      if (_sessionState && _sessionStateToken) {
        // Capture the previous state for the transition listener.
        const prevSession = this.sessions.getSessionByToken(_sessionStateToken)
        const prevState = prevSession?.state
        const prevName = prevSession?.name
        this.sessions.setSessionState(_sessionStateToken, _sessionState, _sessionStateGameInstanceId)
        if (prevState && prevName && prevState !== _sessionState) {
          for (const listener of this.stateTransitionListeners) {
            try {
              listener({
                roomId: this.game.gameId,
                token: _sessionStateToken,
                name: prevName,
                from: prevState,
                to: _sessionState,
                gameInstanceId: _sessionStateGameInstanceId,
              })
            } catch (err) {
              console.error(`[${this.game.gameId}] state-transition listener threw:`, err)
            }
          }
        }
      }

      // session:state events carry only state-change metadata and are not
      // broadcast or surfaced to listeners. They're an internal channel for
      // games to mark sessions as in-game/lobby.
      if (broadcastable.type === 'session:state') {
        continue
      }

      if (_targetPlayer) {
        this.broadcastToPlayer(_targetPlayer, broadcastable)
      } else {
        this.broadcastEverywhere(broadcastable)
      }

      for (const listener of this.eventListeners) {
        try {
          listener({
            type: broadcastable.type,
            data: broadcastable.data,
            _targetPlayer,
            roomId: this.game.gameId,
          })
        } catch (err) {
          console.error(`[${this.game.gameId}] event listener threw:`, err)
        }
      }

      if (_nextPhaseTimeout) {
        const timerKey = _phaseTimerKey ?? 'default'
        this.clearPhaseTimer(timerKey)
        this.phaseTimers.set(timerKey, setTimeout(() => {
          this.phaseTimers.delete(timerKey)
          const timeoutEvents = this.game.onPhaseTimeout(timerKey)
          this.dispatchEvents(timeoutEvents)
          if (this.game.getPhase() === 'LOBBY') {
            this.tryAutoStart()
          }
        }, _nextPhaseTimeout))
      }
    }
  }

  clearPhaseTimer(timerKey: string = 'default'): void {
    const timer = this.phaseTimers.get(timerKey)
    if (timer) {
      clearTimeout(timer)
      this.phaseTimers.delete(timerKey)
    }
  }

  clearAllPhaseTimers(): void {
    for (const timer of this.phaseTimers.values()) {
      clearTimeout(timer)
    }
    this.phaseTimers.clear()
  }

  tryAutoStart(): void {
    // Only lobby-state players are eligible to start a game. Connected players
    // haven't opted in; in-game players are already in one.
    const players = this.sessions.getActiveSessions()
      .filter(s => s.state === 'lobby')
      .map(s => ({
        name: s.name,
        token: s.token,
        role: s.role,
      }))
    if (this.game.canStartGame(players)) {
      const events = this.game.startRound(players)
      const roles = this.game.getRoleAssignments(players)
      for (const [token, role] of roles) {
        this.sessions.setRole(token, role)
      }
      this.dispatchEvents(events)
    }
  }

  handleMessage(player: PlayerInfo, message: string): void {
    this.broadcastEverywhere({
      type: 'player:message',
      data: {
        from: player.name,
        message,
        timestamp: new Date().toISOString(),
      },
    })
  }

  /**
   * Transition a session from 'connected' to 'lobby'. Triggers the game
   * module's onPlayerJoin (which is what adds them to the lobby roster).
   * No-op if already in the lobby. Rejected if in-game.
   *
   * See docs/player-state.md.
   */
  handleEnterLobby(player: PlayerInfo): { ok: true } | { ok: false; error: string } {
    const session = this.sessions.getSessionByToken(player.token)
    if (!session) return { ok: false, error: 'Session not found' }
    if (session.state === 'in-game') {
      return { ok: false, error: 'You are in a game and cannot enter the lobby' }
    }
    if (session.state === 'lobby') {
      return { ok: true } // idempotent
    }
    // connected → lobby. The state transition fires via dispatchEvents
    // (which also triggers analytics state-transition recording).
    const gameEvents = this.game.onPlayerJoin(player)
    this.dispatchEvents([
      { type: 'session:state', data: {}, _sessionState: 'lobby', _sessionStateToken: player.token },
      ...gameEvents,
    ])
    return { ok: true }
  }

  /**
   * Transition a session from 'lobby' back to 'connected'. Triggers the
   * game module's onPlayerLeave with reason 'left_lobby'. No-op if already
   * connected. Rejected if in-game.
   */
  handleLeaveLobby(player: PlayerInfo): { ok: true } | { ok: false; error: string } {
    const session = this.sessions.getSessionByToken(player.token)
    if (!session) return { ok: false, error: 'Session not found' }
    if (session.state === 'in-game') {
      return { ok: false, error: 'You are in a game; leave it first' }
    }
    if (session.state === 'connected') {
      return { ok: true } // idempotent
    }
    // lobby → connected. Game module sees the leave; state transition fires
    // via dispatchEvents (which also triggers analytics).
    const gameEvents = this.game.onPlayerLeave(player, 'left_lobby')
    this.dispatchEvents([
      ...gameEvents,
      { type: 'session:state', data: {}, _sessionState: 'connected', _sessionStateToken: player.token },
    ])
    return { ok: true }
  }

  sendHeartbeat(): void {
    const payload = `event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`
    for (const session of this.sessions.getActiveSessions()) {
      for (const client of session.sseClients) {
        this.safeWrite(client, payload)
      }
    }
    for (const client of this.audienceClients) {
      this.safeWrite(client, payload)
    }
  }
}
