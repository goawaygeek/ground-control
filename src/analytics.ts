import type { GameRoom } from './game-room.js'
import type { EventStore } from './event-store.js'
import { CHESS_BOT_NAME } from './game/chess/index.js'

interface GameStartContext {
  startedAt: number
}

export class Analytics {
  private startedGames = new Map<string, GameStartContext>()

  constructor(private store: EventStore) {}

  async recordJoin(info: { game: string; name: string; isReconnect: boolean }): Promise<void> {
    await this.safeLog({
      type: 'player:join',
      game: info.game,
      data: { name: info.name, isReconnect: info.isReconnect },
    })
  }

  subscribe(room: GameRoom): () => void {
    const unsubscribeEvents = room.onEvent((event) => {
      if (event.type === 'game:start') {
        this.handleGameStart(event.roomId, event.data as Record<string, unknown>)
      } else if (event.type === 'game:over') {
        this.handleGameOver(event.roomId, event.data as Record<string, unknown>)
      } else if (event.type === 'player:left') {
        this.handlePlayerLeft(event.roomId, event.data as Record<string, unknown>)
      }
    })
    const unsubscribeTransitions = room.onStateTransition((transition) => {
      this.safeLog({
        type: 'state-transition',
        game: transition.roomId,
        data: {
          name: transition.name,
          from: transition.from,
          to: transition.to,
          gameInstanceId: transition.gameInstanceId,
        },
      })
    })
    return () => {
      unsubscribeEvents()
      unsubscribeTransitions()
    }
  }

  private handlePlayerLeft(roomId: string, data: Record<string, unknown>): void {
    this.safeLog({
      type: 'player:left',
      game: roomId,
      data: { name: data.name, reason: data.reason },
    })
  }

  private handleGameStart(roomId: string, data: Record<string, unknown>): void {
    const gameInstanceId = data.gameInstanceId as string | undefined
    if (gameInstanceId) {
      this.startedGames.set(gameInstanceId, { startedAt: Date.now() })
    }
    this.safeLog({
      type: 'game:start',
      game: roomId,
      data: {
        gameInstanceId,
        white: data.white,
        black: data.black,
        includesBot: data.white === CHESS_BOT_NAME || data.black === CHESS_BOT_NAME,
      },
    })
  }

  private handleGameOver(roomId: string, data: Record<string, unknown>): void {
    const gameInstanceId = data.gameInstanceId as string | undefined
    let durationMs: number | undefined
    if (gameInstanceId) {
      const ctx = this.startedGames.get(gameInstanceId)
      if (ctx) {
        durationMs = Date.now() - ctx.startedAt
        this.startedGames.delete(gameInstanceId)
      }
    }
    this.safeLog({
      type: 'game:over',
      game: roomId,
      data: {
        gameInstanceId,
        winner: data.winner,
        loser: data.loser,
        reason: data.reason,
        durationMs,
      },
    })
  }

  private safeLog(input: Parameters<EventStore['logEvent']>[0]): Promise<void> {
    return this.store.logEvent(input).catch(err => {
      console.error('[analytics] logEvent failed:', err)
    })
  }
}
