import type { GameModule } from './types.js'
import { ComedyBattle } from './comedy-battle/index.js'
import { ChessGame } from './chess/index.js'

const AVAILABLE_GAMES = ['comedy-battle', 'chess'] as const

export function getAvailableGames(): string[] {
  return [...AVAILABLE_GAMES]
}

export function createGame(gameId: string = 'comedy-battle'): GameModule {
  switch (gameId) {
    case 'comedy-battle':
      return new ComedyBattle()
    case 'chess':
      return new ChessGame()
    default:
      throw new Error(`Unknown game: "${gameId}". Available games: comedy-battle, chess`)
  }
}
