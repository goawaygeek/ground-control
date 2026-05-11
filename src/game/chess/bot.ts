import { Chess } from 'chess.js'

const PIECE_VALUE: Record<string, number> = {
  p: 1, n: 3, b: 3, r: 5, q: 9, k: 0,
}

export type Rng = () => number

/**
 * Picks a chess move using a material-greedy heuristic.
 *
 *   +1000  checkmate
 *   +100   any check
 *   +10×V  capture of a piece worth V
 *   -5×V   moving piece of value V onto a square attacked by the opponent
 *          and not defended by us (hanging)
 *
 * Ties are broken by `rng()` (uniform in [0, 1)). Returns the chosen move in
 * SAN notation, or `null` if the position has no legal moves.
 */
export function chooseMove(fen: string, rng: Rng = Math.random): string | null {
  const engine = new Chess(fen)
  const moves = engine.moves({ verbose: true })
  if (moves.length === 0) return null

  const us = engine.turn()
  const them = us === 'w' ? 'b' : 'w'

  let bestScore = -Infinity
  const bestMoves: string[] = []

  for (const move of moves) {
    let score = 0

    // Capture bonus: the captured piece's value × 10.
    if (move.captured) {
      score += (PIECE_VALUE[move.captured] ?? 0) * 10
    }

    // Probe the position after the move for check / checkmate / hanging.
    const probe = new Chess(fen)
    probe.move(move.san)

    if (probe.isCheckmate()) {
      score += 1000
    } else if (probe.inCheck()) {
      score += 100
    }

    // Hanging-piece penalty: if the destination square is attacked by them
    // and not defended by us (after the move), penalise by our piece value.
    const attackersOnDest = probe.attackers(move.to, them)
    if (attackersOnDest.length > 0) {
      const defendersOnDest = probe.attackers(move.to, us)
      if (defendersOnDest.length === 0) {
        score -= (PIECE_VALUE[move.piece] ?? 0) * 5
      }
    }

    if (score > bestScore) {
      bestScore = score
      bestMoves.length = 0
      bestMoves.push(move.san)
    } else if (score === bestScore) {
      bestMoves.push(move.san)
    }
  }

  const index = Math.min(bestMoves.length - 1, Math.floor(rng() * bestMoves.length))
  return bestMoves[index]
}
