import type { GameRoom } from '../../game-room.js'
import { ChessGame, CHESS_BOT_NAME } from './index.js'
import { chooseMove, type Rng } from './bot.js'

interface BotGameContext {
  gameInstanceId: string
  botColor: 'white' | 'black'
  botToken: string
  botName: string
}

/**
 * Subscribes to a `GameRoom` hosting a `ChessGame` and dispatches bot moves
 * whenever it's the bot's turn in a `play_bot`-initiated game.
 *
 * Bot moves are scheduled via `setImmediate` so we never re-enter
 * `dispatchEvents` while it is still iterating phase timers / listeners for
 * the current event.
 */
export class ChessBotRunner {
  private contexts = new Map<string, BotGameContext>()
  private unsubscribe: (() => void) | null = null

  constructor(private room: GameRoom, private rng: Rng = Math.random) {}

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.room.onEvent((event) => {
      if (event.type === 'game:start') {
        this.handleGameStart(event.data as Record<string, unknown>)
      } else if (event.type === 'move:made') {
        this.handleMoveMade(event.data as Record<string, unknown>)
      } else if (event.type === 'game:over') {
        this.handleGameOver(event.data as Record<string, unknown>)
      }
    })
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    this.contexts.clear()
  }

  private handleGameStart(data: Record<string, unknown>): void {
    const gameInstanceId = data.gameInstanceId as string | undefined
    if (!gameInstanceId) return

    const chess = this.room.game as ChessGame
    const instance = chess.getInstanceById(gameInstanceId)
    if (!instance) return

    let context: BotGameContext | null = null
    if (instance.whitePlayer.name === CHESS_BOT_NAME) {
      context = {
        gameInstanceId,
        botColor: 'white',
        botToken: instance.whitePlayer.token,
        botName: instance.whitePlayer.name,
      }
    } else if (instance.blackPlayer.name === CHESS_BOT_NAME) {
      context = {
        gameInstanceId,
        botColor: 'black',
        botToken: instance.blackPlayer.token,
        botName: instance.blackPlayer.name,
      }
    }

    if (!context) return
    this.contexts.set(gameInstanceId, context)

    // If the bot is white, it needs to make the opening move.
    if (context.botColor === 'white') {
      this.scheduleBotMove(context)
    }
  }

  private handleMoveMade(data: Record<string, unknown>): void {
    const gameInstanceId = data.gameInstanceId as string | undefined
    if (!gameInstanceId) return
    const context = this.contexts.get(gameInstanceId)
    if (!context) return

    const turn = data.turn as 'white' | 'black' | undefined
    if (turn === context.botColor) {
      this.scheduleBotMove(context)
    }
  }

  private handleGameOver(data: Record<string, unknown>): void {
    const gameInstanceId = data.gameInstanceId as string | undefined
    if (gameInstanceId) this.contexts.delete(gameInstanceId)
  }

  private scheduleBotMove(context: BotGameContext): void {
    setImmediate(() => {
      // Re-check: game might have ended between the schedule and the fire.
      if (!this.contexts.has(context.gameInstanceId)) return

      const chess = this.room.game as ChessGame
      const instance = chess.getInstanceById(context.gameInstanceId)
      if (!instance) return

      const move = chooseMove(instance.engine.fen(), this.rng)
      if (!move) return

      const result = chess.onAction(
        { name: context.botName, token: context.botToken, role: context.botColor },
        'make_move',
        { move },
      )
      if (!result.ok) {
        console.error(`[chessbot] illegal move attempt: ${result.error}`)
        return
      }
      this.room.dispatchEvents(result.events)
    })
  }
}
