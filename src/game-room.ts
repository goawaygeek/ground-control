import { ServerResponse } from 'node:http'
import { SessionManager } from './auth.js'
import type { GameModule, GameEvent, PlayerInfo } from './game/types.js'
import type { PlayerStore } from './store.js'

export class GameRoom {
  readonly game: GameModule
  readonly sessions: SessionManager
  readonly audienceClients = new Set<ServerResponse>()
  private phaseTimers = new Map<string, NodeJS.Timeout>()

  constructor(game: GameModule, store?: PlayerStore) {
    this.game = game
    this.sessions = new SessionManager(store)
  }

  broadcastToPlayer(token: string, event: { type: string; data: unknown }): void {
    const session = this.sessions.getSessionByToken(token)
    if (!session) return
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`
    for (const res of session.sseClients) {
      res.write(payload)
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
      res.write(payload)
    }
  }

  broadcastEverywhere(event: { type: string; data: unknown }): void {
    this.broadcastToAllPlayers(event)
    this.broadcastToAudience(event)
  }

  dispatchEvents(events: GameEvent[]): void {
    for (const event of events) {
      const { _nextPhaseTimeout, _targetPlayer, _phaseTimerKey, ...broadcastable } = event

      if (_targetPlayer) {
        this.broadcastToPlayer(_targetPlayer, broadcastable)
      } else {
        this.broadcastEverywhere(broadcastable)
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
    const players = this.sessions.getActiveSessions().map(s => ({
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

  sendHeartbeat(): void {
    const payload = `event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`
    for (const session of this.sessions.getActiveSessions()) {
      for (const client of session.sseClients) {
        client.write(payload)
      }
    }
    for (const client of this.audienceClients) {
      client.write(payload)
    }
  }
}
