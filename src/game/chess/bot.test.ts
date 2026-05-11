import { describe, it, expect } from 'vitest'
import { Chess } from 'chess.js'
import { chooseMove } from './bot.js'

// Deterministic RNG that always picks the first element (rng() === 0).
const firstRng = () => 0

describe('chooseMove', () => {
  it('returns a legal move from the starting position', () => {
    const fen = new Chess().fen()
    const move = chooseMove(fen, firstRng)
    expect(move).not.toBeNull()
    const engine = new Chess(fen)
    const legal = engine.moves()
    expect(legal).toContain(move)
  })

  it('returns null when the game is already over (checkmate)', () => {
    // Fool's mate position: black has just delivered Qh4#
    const fen = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3'
    expect(chooseMove(fen, firstRng)).toBeNull()
  })

  it('returns null when no legal moves exist (stalemate)', () => {
    // Classic stalemate: black king on a8, white queen on c7, white king on c6, black to move.
    const fen = 'k7/2Q5/2K5/8/8/8/8/8 b - - 0 1'
    expect(chooseMove(fen, firstRng)).toBeNull()
  })

  it('prefers checkmate when available', () => {
    // White to move, Qh5# is mate.
    // Position: black king f7-isolated; white queen can deliver mate via Qxf7#.
    // Simpler: back-rank mate. White rook on a1, black king on h8, no escape.
    // Setup: 7k/6pp/8/8/8/8/8/R6K w - - 0 1 — Ra8# is mate.
    const fen = '7k/6pp/8/8/8/8/8/R6K w - - 0 1'
    const move = chooseMove(fen, firstRng)
    expect(move).toBe('Ra8#')
  })

  it('prefers capturing a higher-value piece over a quiet move when free', () => {
    // White to move. White knight on d4 can capture an undefended black queen on f5.
    // FEN: black king h8, black queen f5 (no defenders), white knight d4, white king a1, white to move.
    const fen = '7k/8/8/5q2/3N4/8/8/K7 w - - 0 1'
    const move = chooseMove(fen, firstRng)
    expect(move).toBe('Nxf5')
  })

  it('avoids hanging a piece when a safe alternative exists', () => {
    // White to move. White queen on d1 — if it moves to d5 (attacked by black pawn on e6,
    // not defended), that's a hang. A safer move like Qd2 should be preferred.
    // Setup: black king h8, black pawn e6, white queen d1, white king a1, white to move.
    const fen = '7k/8/4p3/8/8/8/8/K2Q4 w - - 0 1'
    // We don't pin to a specific move; we just assert the bot does not pick Qd5
    // (which hangs the queen to exd5 for free).
    const move = chooseMove(fen, firstRng)
    expect(move).not.toBe('Qd5')
  })

  it('uses the rng to break ties among equally-good moves', () => {
    // Starting position — all 20 moves have similar scores. Different rng outputs
    // can choose different moves.
    const fen = new Chess().fen()
    const moveA = chooseMove(fen, () => 0)
    const moveZ = chooseMove(fen, () => 0.999999)
    // Not strictly required to differ, but on the opening they should
    // since all 20 moves score 0 and the bot picks among them.
    expect(moveA).not.toBeNull()
    expect(moveZ).not.toBeNull()
    expect(moveA).not.toBe(moveZ)
  })

  it('returns a string in SAN format that chess.js accepts', () => {
    const engine = new Chess()
    const move = chooseMove(engine.fen(), firstRng)
    expect(move).not.toBeNull()
    // Should not throw — engine accepts our SAN string.
    expect(() => engine.move(move!)).not.toThrow()
  })
})
