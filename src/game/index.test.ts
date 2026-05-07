import { describe, it, expect } from 'vitest'
import { createGame, getAvailableGames } from './index.js'

describe('createGame', () => {
  it('creates a comedy-battle game', () => {
    const game = createGame('comedy-battle')
    expect(game.gameId).toBe('comedy-battle')
    expect(game.getPhase()).toBe('LOBBY')
  })

  it('creates a chess game', () => {
    const game = createGame('chess')
    expect(game.gameId).toBe('chess')
    expect(game.getPhase()).toBe('LOBBY')
  })

  it('throws for unknown game id', () => {
    expect(() => createGame('nonexistent')).toThrow('Unknown game')
  })

  it('defaults to comedy-battle', () => {
    const game = createGame()
    expect(game.gameId).toBe('comedy-battle')
  })
})

describe('getAvailableGames', () => {
  it('returns all available game ids', () => {
    const games = getAvailableGames()
    expect(games).toContain('comedy-battle')
    expect(games).toContain('chess')
    expect(games).toHaveLength(2)
  })

  it('returns a new array each time (not a reference to internal state)', () => {
    const a = getAvailableGames()
    const b = getAvailableGames()
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })
})
