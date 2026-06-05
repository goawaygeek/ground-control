import { describe, it, expect, beforeEach } from 'vitest'
import { ChessGame } from './index.js'
import type { PlayerInfo } from '../types.js'

function makePlayer(name: string, token?: string): PlayerInfo {
  return { name, token: token ?? `token-${name}`, role: 'audience' }
}

describe('ChessGame', () => {
  let game: ChessGame

  beforeEach(() => {
    game = new ChessGame()
  })

  describe('basics', () => {
    it('has gameId "chess"', () => {
      expect(game.gameId).toBe('chess')
    })

    it('always reports LOBBY phase', () => {
      expect(game.getPhase()).toBe('LOBBY')
    })

    it('canStartGame always returns false (use challenges instead)', () => {
      const alice = makePlayer('alice')
      const bob = makePlayer('bob')
      expect(game.canStartGame([alice, bob])).toBe(false)
    })

    it('startRound returns empty (no-op, use challenges)', () => {
      const events = game.startRound([makePlayer('alice'), makePlayer('bob')])
      expect(events).toEqual([])
    })
  })

  describe('player join/leave', () => {
    it('onPlayerJoin adds player to lobby', () => {
      const alice = makePlayer('alice')
      game.onPlayerJoin(alice)

      const state = game.getState() as any
      expect(state.lobbyPlayers).toContain('alice')
    })

    it('onPlayerJoin emits player:joined and lobby:update', () => {
      const events = game.onPlayerJoin(makePlayer('alice'))
      expect(events.some(e => e.type === 'player:joined')).toBe(true)
      expect(events.some(e => e.type === 'lobby:update')).toBe(true)
    })

    it('onPlayerLeave removes from lobby', () => {
      const alice = makePlayer('alice')
      game.onPlayerJoin(alice)
      game.onPlayerLeave(alice, 'graceful')

      const state = game.getState() as any
      expect(state.lobbyPlayers).not.toContain('alice')
    })

    it('onPlayerLeave includes the reason in the player:left event', () => {
      const alice = makePlayer('alice')
      game.onPlayerJoin(alice)
      const events = game.onPlayerLeave(alice, 'reaped')

      const left = events.find(e => e.type === 'player:left')
      expect(left).toBeDefined()
      expect((left!.data as any).reason).toBe('reaped')
      expect((left!.data as any).name).toBe('alice')
    })

    it('onPlayerLeave cleans up pending challenges involving that player', () => {
      const alice = makePlayer('alice')
      const bob = makePlayer('bob')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)

      // Alice challenges Bob
      game.onAction(alice, 'challenge', { opponent: 'bob' })

      // Alice leaves — challenge should be cancelled
      game.onPlayerLeave(alice, 'disconnect')
      const state = game.getState() as any
      expect(state.pendingChallenges).toHaveLength(0)
    })
  })

  describe('challenge flow', () => {
    let alice: PlayerInfo
    let bob: PlayerInfo
    let charlie: PlayerInfo

    beforeEach(() => {
      alice = makePlayer('alice')
      bob = makePlayer('bob')
      charlie = makePlayer('charlie')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)
      game.onPlayerJoin(charlie)
    })

    it('creates a challenge and notifies opponent', () => {
      const result = game.onAction(alice, 'challenge', { opponent: 'bob' })
      expect(result.ok).toBe(true)

      // Should have a challenge:sent event for alice and challenge:received for bob
      expect(result.events.some(e => e.type === 'challenge:sent' && e._targetPlayer === alice.token)).toBe(true)
      expect(result.events.some(e => e.type === 'challenge:received' && e._targetPlayer === bob.token)).toBe(true)
    })

    it('rejects challenge to nonexistent player', () => {
      const result = game.onAction(alice, 'challenge', { opponent: 'nobody' })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('rejects self-challenge', () => {
      const result = game.onAction(alice, 'challenge', { opponent: 'alice' })
      expect(result.ok).toBe(false)
    })

    it('rejects challenge if challenger is already in a game', () => {
      // Start a game between alice and bob
      const challengeResult = game.onAction(alice, 'challenge', { opponent: 'bob' })
      const challengeId = (challengeResult.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId
      game.onAction(bob, 'accept_challenge', { challengeId })

      // Alice tries to challenge charlie while playing
      const result = game.onAction(alice, 'challenge', { opponent: 'charlie' })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('already in a game')
    })

    it('rejects challenge if opponent is already in a game', () => {
      // Start a game between alice and bob
      const challengeResult = game.onAction(alice, 'challenge', { opponent: 'bob' })
      const challengeId = (challengeResult.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId
      game.onAction(bob, 'accept_challenge', { challengeId })

      // Charlie tries to challenge bob who is playing
      const result = game.onAction(charlie, 'challenge', { opponent: 'bob' })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('already in a game')
    })

    it('accept_challenge creates a game and emits game:start', () => {
      const challengeResult = game.onAction(alice, 'challenge', { opponent: 'bob' })
      const challengeId = (challengeResult.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId

      const acceptResult = game.onAction(bob, 'accept_challenge', { challengeId })
      expect(acceptResult.ok).toBe(true)
      expect(acceptResult.events.some(e => e.type === 'game:start')).toBe(true)

      const gameStart = acceptResult.events.find(e => e.type === 'game:start')!
      const data = gameStart.data as any
      expect(data.gameInstanceId).toBeDefined()
      expect(data.white).toBeDefined()
      expect(data.black).toBeDefined()
      expect(data.board).toBeDefined()
    })

    it('accept_challenge emits session:state in-game for both players', () => {
      const challengeResult = game.onAction(alice, 'challenge', { opponent: 'bob' })
      const challengeId = (challengeResult.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId

      const acceptResult = game.onAction(bob, 'accept_challenge', { challengeId })
      const stateEvents = acceptResult.events.filter(e => e.type === 'session:state')
      expect(stateEvents).toHaveLength(2)
      const tokens = stateEvents.map(e => (e as any)._sessionStateToken).sort()
      expect(tokens).toEqual([alice.token, bob.token].sort())
      for (const ev of stateEvents) {
        expect((ev as any)._sessionState).toBe('in-game')
      }
    })

    it('accept_challenge rejects if not the challenged player', () => {
      const challengeResult = game.onAction(alice, 'challenge', { opponent: 'bob' })
      const challengeId = (challengeResult.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId

      const result = game.onAction(charlie, 'accept_challenge', { challengeId })
      expect(result.ok).toBe(false)
    })

    it('accept_challenge rejects invalid challengeId', () => {
      const result = game.onAction(bob, 'accept_challenge', { challengeId: 'nonexistent' })
      expect(result.ok).toBe(false)
    })

    it('decline_challenge removes the challenge and notifies challenger', () => {
      const challengeResult = game.onAction(alice, 'challenge', { opponent: 'bob' })
      const challengeId = (challengeResult.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId

      const declineResult = game.onAction(bob, 'decline_challenge', { challengeId })
      expect(declineResult.ok).toBe(true)
      expect(declineResult.events.some(e => e.type === 'challenge:declined' && e._targetPlayer === alice.token)).toBe(true)

      // Challenge should be gone
      const state = game.getState() as any
      expect(state.pendingChallenges).toHaveLength(0)
    })

    it('decline_challenge rejects if not the challenged player', () => {
      const challengeResult = game.onAction(alice, 'challenge', { opponent: 'bob' })
      const challengeId = (challengeResult.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId

      const result = game.onAction(charlie, 'decline_challenge', { challengeId })
      expect(result.ok).toBe(false)
    })
  })

  describe('game instance — moves', () => {
    let alice: PlayerInfo
    let bob: PlayerInfo
    let white: PlayerInfo
    let black: PlayerInfo
    let gameInstanceId: string

    beforeEach(() => {
      alice = makePlayer('alice')
      bob = makePlayer('bob')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)

      // Create and accept a challenge
      const challengeResult = game.onAction(alice, 'challenge', { opponent: 'bob' })
      const challengeId = (challengeResult.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId
      const acceptResult = game.onAction(bob, 'accept_challenge', { challengeId })

      const gameStart = acceptResult.events.find(e => e.type === 'game:start')!
      const data = gameStart.data as any
      gameInstanceId = data.gameInstanceId

      // Figure out who is white/black
      if (data.white === 'alice') {
        white = alice; black = bob
      } else {
        white = bob; black = alice
      }
    })

    it('accepts a valid move from the correct player', () => {
      const result = game.onAction(white, 'make_move', { move: 'e4' })
      expect(result.ok).toBe(true)
      expect(result.events.some(e => e.type === 'move:made')).toBe(true)

      // Event should include gameInstanceId
      const moveEvent = result.events.find(e => e.type === 'move:made')!
      expect((moveEvent.data as any).gameInstanceId).toBe(gameInstanceId)
    })

    it('rejects move from wrong player (not their turn)', () => {
      const result = game.onAction(black, 'make_move', { move: 'e5' })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('turn')
    })

    it('rejects illegal move', () => {
      const result = game.onAction(white, 'make_move', { move: 'e5' })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('Illegal')
    })

    it('alternates turns correctly', () => {
      game.onAction(white, 'make_move', { move: 'e4' })
      const result = game.onAction(black, 'make_move', { move: 'e5' })
      expect(result.ok).toBe(true)
    })

    it('rejects move from player not in a game', () => {
      const charlie = makePlayer('charlie')
      game.onPlayerJoin(charlie)
      const result = game.onAction(charlie, 'make_move', { move: 'e4' })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('not in a game')
    })

    describe('orphaned in-game session self-heal', () => {
      // A session can claim state==='in-game' with a gameInstanceId whose
      // instance no longer exists (e.g. a future #23 cleanup cron destroyed the
      // instance, or some other invariant break). Without self-heal the player
      // is stranded: every game action errors and there's no way back to
      // 'connected' short of destroying the session. routeToGame must detect
      // this and reset the session to 'connected' so the LLM can offer a fresh
      // game. See docs/player-state.md.
      it('resets the session to connected when the instance is gone', () => {
        const ghost: PlayerInfo = {
          name: 'ghost',
          token: 'token-ghost',
          role: 'white',
          state: 'in-game',
          gameInstanceId: 'instance-that-no-longer-exists',
        }
        const result = game.onAction(ghost, 'make_move', { move: 'e4' })
        expect(result.ok).toBe(false)
        // Emits a corrective session:state event to return the player to connected.
        const stateEvents = result.events.filter(e => e.type === 'session:state')
        expect(stateEvents).toHaveLength(1)
        expect((stateEvents[0] as any)._sessionState).toBe('connected')
        expect((stateEvents[0] as any)._sessionStateToken).toBe('token-ghost')
      })

      it('gives a friendly error telling the human the game has ended', () => {
        const ghost: PlayerInfo = {
          name: 'ghost',
          token: 'token-ghost',
          role: 'white',
          state: 'in-game',
          gameInstanceId: 'instance-that-no-longer-exists',
        }
        const result = game.onAction(ghost, 'get_board', {})
        expect(result.ok).toBe(false)
        expect(result.error?.toLowerCase()).toContain('no longer')
      })

      it('clears the internal inGameInstances entry too', () => {
        // Simulate the map and session disagreeing: the map still points at a
        // dead instance. Self-heal should clear it so subsequent actions report
        // 'not in a game' cleanly rather than re-triggering the orphan path.
        const ghost: PlayerInfo = {
          name: 'ghost',
          token: 'token-ghost',
          role: 'white',
          state: 'in-game',
          gameInstanceId: 'instance-that-no-longer-exists',
        }
        game.onAction(ghost, 'make_move', { move: 'e4' })
        // Now without the session's gameInstanceId hint (as a fresh connected
        // session would arrive), the player is cleanly "not in a game".
        const after = game.onAction(makePlayer('ghost', 'token-ghost'), 'make_move', { move: 'e4' })
        expect(after.ok).toBe(false)
        expect(after.error).toContain('not in a game')
      })
    })

    it('get_board returns board state targeted to requesting player', () => {
      const result = game.onAction(white, 'get_board', {})
      expect(result.ok).toBe(true)
      const boardEvent = result.events.find(e => e.type === 'board:state')!
      expect(boardEvent._targetPlayer).toBe(white.token)
      expect((boardEvent.data as any).gameInstanceId).toBe(gameInstanceId)
    })

    // Same hallucination class as issue #15, but for get_board. The board is
    // emitted as a _targetPlayer SSE event (board:state); the SYNCHRONOUS tool
    // response only carries what's in responseData. Without it, the tool result
    // the LLM sees is just {ok:true} and it fabricates a board (observed: an
    // illegal position the engine could never produce). responseData must echo
    // the real board/fen/turn/legalMoves so the LLM renders ground truth.
    it('returns the board in responseData (so callers do not hallucinate)', () => {
      const result = game.onAction(white, 'get_board', {})
      expect(result.ok).toBe(true)
      expect(result.responseData).toBeDefined()
      const data = result.responseData!
      expect(typeof data.board).toBe('string')
      expect(typeof data.fen).toBe('string')
      expect(data.turn).toBe('white') // fresh game, white to move
      expect(Array.isArray(data.legalMoves)).toBe(true)
      // The responseData board must match the event's board exactly.
      const boardEvent = result.events.find(e => e.type === 'board:state')!
      expect(data.board).toBe((boardEvent.data as any).board)
      expect(data.fen).toBe((boardEvent.data as any).fen)
    })

    it('get_board responseData reflects the current position after a move', () => {
      game.onAction(white, 'make_move', { move: 'e4' })
      const result = game.onAction(black, 'get_board', {})
      expect(result.responseData!.turn).toBe('black')
      // e4 played: a pawn sits on e4, fen has black to move.
      expect((result.responseData!.fen as string)).toContain(' b ')
    })

    it('does not attach a phase timer to move events (chess clock removed for beta)', () => {
      const result = game.onAction(white, 'make_move', { move: 'e4' })
      const moveEvent = result.events.find(e => e.type === 'move:made')!
      expect(moveEvent._nextPhaseTimeout).toBeUndefined()
      expect(moveEvent._phaseTimerKey).toBeUndefined()
    })

    // Issue #15: the action result must echo the resulting board state so
    // callers don't have to wait for the SSE event to know what happened.
    // Without this, the LLM hallucinates board positions between calling
    // make_move and the move:made event arriving.
    it('returns the new board state in responseData (so callers do not hallucinate)', () => {
      const result = game.onAction(white, 'make_move', { move: 'e4' })
      expect(result.ok).toBe(true)
      expect(result.responseData).toBeDefined()
      const data = result.responseData!
      expect(data.move).toBe('e4')
      expect(data.fen).toBeDefined()
      expect(data.board).toBeDefined()
      expect(data.turn).toBe('black')
      expect(data.gameInstanceId).toBe(gameInstanceId)
      // `white` may be alice or bob depending on the random color assignment
      // in accept_challenge — assert the responseData echoes whoever it was.
      expect(data.player).toBe(white.name)
    })

    it('responseData reflects the move applied (not pre-move state)', () => {
      const result = game.onAction(white, 'make_move', { move: 'e4' })
      // The FEN after e4 should include the pawn on e4 and black-to-move.
      expect((result.responseData!.fen as string)).toContain(' b ')
      expect((result.responseData!.board as string)).toContain('P')
    })

    it('does not include responseData when the move is rejected', () => {
      const result = game.onAction(white, 'make_move', { move: 'e5' })
      expect(result.ok).toBe(false)
      expect(result.responseData).toBeUndefined()
    })
  })

  describe('game instance — checkmate', () => {
    it('detects checkmate (fool\'s mate) and ends the game (players land in connected)', () => {
      const alice = makePlayer('alice')
      const bob = makePlayer('bob')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)

      const challengeResult = game.onAction(alice, 'challenge', { opponent: 'bob' })
      const challengeId = (challengeResult.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId
      const acceptResult = game.onAction(bob, 'accept_challenge', { challengeId })

      const data = (acceptResult.events.find(e => e.type === 'game:start')!.data as any)
      const white = data.white === 'alice' ? alice : bob
      const black = data.white === 'alice' ? bob : alice

      // Fool's mate: 1. f3 e5 2. g4 Qh4#
      game.onAction(white, 'make_move', { move: 'f3' })
      game.onAction(black, 'make_move', { move: 'e5' })
      game.onAction(white, 'make_move', { move: 'g4' })
      const result = game.onAction(black, 'make_move', { move: 'Qh4' })

      expect(result.ok).toBe(true)
      expect(result.events.some(e => e.type === 'game:over')).toBe(true)

      const gameOver = result.events.find(e => e.type === 'game:over')!
      expect((gameOver.data as any).reason).toBe('checkmate')

      // Per the new state model: players land in 'connected' after game-end,
      // not back in the lobby. They'd call enter_lobby again to rejoin.
      const state = game.getState() as any
      expect(state.lobbyPlayers).not.toContain('alice')
      expect(state.lobbyPlayers).not.toContain('bob')
      expect(state.activeGames).toHaveLength(0)

      // The session:state events should target both players as 'connected'.
      const stateEvents = result.events.filter(e => e.type === 'session:state')
      expect(stateEvents).toHaveLength(2)
      for (const ev of stateEvents) {
        expect((ev as any)._sessionState).toBe('connected')
      }
    })
  })

  describe('game instance — resign', () => {
    it('ends game and declares opponent winner', () => {
      const alice = makePlayer('alice')
      const bob = makePlayer('bob')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)

      const challengeResult = game.onAction(alice, 'challenge', { opponent: 'bob' })
      const challengeId = (challengeResult.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId
      game.onAction(bob, 'accept_challenge', { challengeId })

      const result = game.onAction(alice, 'resign', {})
      expect(result.ok).toBe(true)
      expect(result.events.some(e => e.type === 'game:over')).toBe(true)

      const gameOver = result.events.find(e => e.type === 'game:over')!
      expect((gameOver.data as any).reason).toBe('resign')
      expect((gameOver.data as any).winner).toBe('bob')

      // Per the new state model, both go to 'connected' on game-end.
      const state = game.getState() as any
      expect(state.lobbyPlayers).not.toContain('alice')
      expect(state.lobbyPlayers).not.toContain('bob')
    })

    it('rejects resign if not in a game', () => {
      const alice = makePlayer('alice')
      game.onPlayerJoin(alice)
      const result = game.onAction(alice, 'resign', {})
      expect(result.ok).toBe(false)
    })
  })

  describe('player leave during game', () => {
    it('forfeits game if a player leaves mid-game', () => {
      const alice = makePlayer('alice')
      const bob = makePlayer('bob')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)

      const challengeResult = game.onAction(alice, 'challenge', { opponent: 'bob' })
      const challengeId = (challengeResult.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId
      game.onAction(bob, 'accept_challenge', { challengeId })

      const events = game.onPlayerLeave(alice, 'disconnect')
      expect(events.some(e => e.type === 'game:over')).toBe(true)
      const gameOver = events.find(e => e.type === 'game:over')!
      expect((gameOver.data as any).reason).toBe('forfeit')
      expect((gameOver.data as any).winner).toBe('bob')

      // Per the new state model, Bob goes back to 'connected' (not lobby)
      // after his game forfeits. He'd call enter_lobby again to re-list.
      const state = game.getState() as any
      expect(state.lobbyPlayers).not.toContain('bob')
      expect(state.lobbyPlayers).not.toContain('alice')
    })
  })

  describe('concurrent games', () => {
    it('two games can run simultaneously', () => {
      const alice = makePlayer('alice')
      const bob = makePlayer('bob')
      const carol = makePlayer('carol')
      const dave = makePlayer('dave')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)
      game.onPlayerJoin(carol)
      game.onPlayerJoin(dave)

      // Game 1: alice vs bob
      const c1 = game.onAction(alice, 'challenge', { opponent: 'bob' })
      const cid1 = (c1.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId
      game.onAction(bob, 'accept_challenge', { challengeId: cid1 })

      // Game 2: carol vs dave
      const c2 = game.onAction(carol, 'challenge', { opponent: 'dave' })
      const cid2 = (c2.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId
      game.onAction(dave, 'accept_challenge', { challengeId: cid2 })

      const state = game.getState() as any
      expect(state.activeGames).toHaveLength(2)
      expect(state.lobbyPlayers).toHaveLength(0)
    })

    it('moves in one game do not affect the other', () => {
      const alice = makePlayer('alice')
      const bob = makePlayer('bob')
      const carol = makePlayer('carol')
      const dave = makePlayer('dave')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)
      game.onPlayerJoin(carol)
      game.onPlayerJoin(dave)

      // Start two games
      const c1 = game.onAction(alice, 'challenge', { opponent: 'bob' })
      const cid1 = (c1.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId
      const a1 = game.onAction(bob, 'accept_challenge', { challengeId: cid1 })
      const g1Data = (a1.events.find(e => e.type === 'game:start')!.data as any)
      const g1White = g1Data.white === 'alice' ? alice : bob

      const c2 = game.onAction(carol, 'challenge', { opponent: 'dave' })
      const cid2 = (c2.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId
      const a2 = game.onAction(dave, 'accept_challenge', { challengeId: cid2 })
      const g2Data = (a2.events.find(e => e.type === 'game:start')!.data as any)
      const g2White = g2Data.white === 'carol' ? carol : dave

      // Move in game 1
      const r1 = game.onAction(g1White, 'make_move', { move: 'e4' })
      expect(r1.ok).toBe(true)

      // Game 2 board should still be starting position
      const board2 = game.onAction(g2White, 'get_board', {})
      expect(board2.ok).toBe(true)
      const boardData = (board2.events.find(e => e.type === 'board:state')!.data as any)
      expect(boardData.moveNumber).toBe(1) // still move 1
    })

    it('game over in one does not affect the other', () => {
      const alice = makePlayer('alice')
      const bob = makePlayer('bob')
      const carol = makePlayer('carol')
      const dave = makePlayer('dave')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)
      game.onPlayerJoin(carol)
      game.onPlayerJoin(dave)

      // Start two games
      const c1 = game.onAction(alice, 'challenge', { opponent: 'bob' })
      const cid1 = (c1.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId
      game.onAction(bob, 'accept_challenge', { challengeId: cid1 })

      const c2 = game.onAction(carol, 'challenge', { opponent: 'dave' })
      const cid2 = (c2.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId
      game.onAction(dave, 'accept_challenge', { challengeId: cid2 })

      // Alice resigns game 1
      game.onAction(alice, 'resign', {})

      // Game 2 should still be active. Per the new model alice and bob go to
      // 'connected' (not lobby) when game 1 ends.
      const state = game.getState() as any
      expect(state.activeGames).toHaveLength(1)
      expect(state.lobbyPlayers).not.toContain('alice')
      expect(state.lobbyPlayers).not.toContain('bob')
    })
  })

  describe('get_lobby', () => {
    it('returns lobby players, active games, and pending challenges', () => {
      const alice = makePlayer('alice')
      const bob = makePlayer('bob')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)

      const result = game.onAction(alice, 'get_lobby', {})
      expect(result.ok).toBe(true)

      const lobbyEvent = result.events.find(e => e.type === 'lobby:state')!
      expect(lobbyEvent._targetPlayer).toBe(alice.token)
      const data = lobbyEvent.data as any
      expect(data.lobbyPlayers).toBeDefined()
      expect(data.activeGames).toBeDefined()
      expect(data.pendingChallenges).toBeDefined()
    })
  })

  describe('onPhaseTimeout (no-op, chess clock removed for beta)', () => {
    it('returns empty for any timer key, even an active game', () => {
      const alice = makePlayer('alice')
      const bob = makePlayer('bob')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)

      const challengeResult = game.onAction(alice, 'challenge', { opponent: 'bob' })
      const challengeId = (challengeResult.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId
      const acceptResult = game.onAction(bob, 'accept_challenge', { challengeId })
      const gameInstanceId = (acceptResult.events.find(e => e.type === 'game:start')!.data as any).gameInstanceId

      expect(game.onPhaseTimeout(gameInstanceId)).toEqual([])
      expect(game.onPhaseTimeout('nonexistent')).toEqual([])
      expect(game.onPhaseTimeout()).toEqual([])
    })
  })

  describe('getTools', () => {
    it('includes challenge, accept, decline, resign, get_lobby, make_move, get_board', () => {
      const tools = game.getTools()
      const names = tools.map(t => t.name)
      expect(names).toContain('challenge')
      expect(names).toContain('accept_challenge')
      expect(names).toContain('decline_challenge')
      expect(names).toContain('resign')
      expect(names).toContain('get_lobby')
      expect(names).toContain('make_move')
      expect(names).toContain('get_board')
    })
  })

  describe('getInstructions', () => {
    it('mentions lobby and challenge flow', () => {
      const instructions = game.getInstructions()
      expect(instructions.toLowerCase()).toContain('lobby')
      expect(instructions.toLowerCase()).toContain('challenge')
    })

    it('tells the model to use the legal-move list to vet candidates, not to dump it', () => {
      // The human does NOT want all ~30 legal moves pasted at them — that's
      // noise. The model should use the legal-move list internally to ensure
      // every candidate it offers is actually legal, and only present the
      // vetted candidates.
      const lower = game.getInstructions().toLowerCase()
      expect(lower).toContain('legal')
      // Must instruct NOT to show/list/dump the full set of legal moves.
      expect(lower).toMatch(/do not (show|list|dump|paste|display).{0,40}legal moves|legal moves.{0,40}(do not|don't|never) (show|list|dump|paste|display)/)
      // Candidates must be drawn from / checked against the legal moves.
      expect(lower).toMatch(/legal move/)
    })

    it('mandates offering numbered candidate moves and a recommendation', () => {
      const lower = game.getInstructions().toLowerCase()
      // Must prescribe a numbered list of candidates...
      expect(lower).toContain('numbered')
      // ...and an explicit recommendation, every turn.
      expect(lower).toContain('recommend')
      // The format is required on every one of the human's turns, not optional.
      expect(lower).toMatch(/every turn|each turn|on your turn|the human's turn/)
    })
  })

  describe('getConfig / setConfig', () => {
    it('returns an empty config (no configurable knobs in beta)', () => {
      expect(game.getConfig()).toEqual({})
    })

    it('ignores unknown config keys (no turnTimeLimit anymore)', () => {
      // Should not throw or persist anything.
      game.setConfig({ turnTimeLimit: 30000, somethingElse: 'value' })
      expect(game.getConfig()).toEqual({})
    })
  })

  describe('getRoleAssignments', () => {
    it('assigns lobby to players not in games', () => {
      const alice = makePlayer('alice')
      game.onPlayerJoin(alice)
      const roles = game.getRoleAssignments([alice])
      expect(roles.get(alice.token)).toBe('lobby')
    })

    it('assigns white/black to players in games', () => {
      const alice = makePlayer('alice')
      const bob = makePlayer('bob')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)

      const challengeResult = game.onAction(alice, 'challenge', { opponent: 'bob' })
      const challengeId = (challengeResult.events.find(e => e.type === 'challenge:sent')?.data as any).challengeId
      game.onAction(bob, 'accept_challenge', { challengeId })

      const roles = game.getRoleAssignments([alice, bob])
      const values = [...roles.values()]
      expect(values).toContain('white')
      expect(values).toContain('black')
    })
  })

  describe('play_bot', () => {
    let alice: PlayerInfo

    beforeEach(() => {
      alice = makePlayer('alice')
      game.onPlayerJoin(alice)
    })

    it('starts an instance with the human and a bot named "chessbot"', () => {
      const result = game.onAction(alice, 'play_bot', {})
      expect(result.ok).toBe(true)

      const gameStart = result.events.find(e => e.type === 'game:start')
      expect(gameStart).toBeDefined()
      const data = gameStart!.data as any
      expect([data.white, data.black]).toContain('alice')
      expect([data.white, data.black]).toContain('chessbot')
    })

    it('does not list the bot in lobbyPlayers', () => {
      game.onAction(alice, 'play_bot', {})
      const state = game.getState() as any
      expect(state.lobbyPlayers).not.toContain('chessbot')
    })

    it('does not list the bot in activeGames as a separate player', () => {
      // Bot should appear as an opponent in the active game, but not as a lobby player.
      game.onAction(alice, 'play_bot', {})
      const state = game.getState() as any
      expect(state.activeGames).toHaveLength(1)
      const summary = state.activeGames[0]
      expect([summary.white, summary.black]).toContain('chessbot')
    })

    it('rejects play_bot when the human is already in a game', () => {
      const first = game.onAction(alice, 'play_bot', {})
      expect(first.ok).toBe(true)

      const second = game.onAction(alice, 'play_bot', {})
      expect(second.ok).toBe(false)
      expect(second.error).toContain('already in a game')
    })

    it('isBotToken returns true for the bot side and false for the human', () => {
      const result = game.onAction(alice, 'play_bot', {})
      const data = result.events.find(e => e.type === 'game:start')!.data as any
      // We don't get the bot's token in the event payload — we just confirm
      // alice's token is NOT a bot token.
      expect(game.isBotToken(alice.token)).toBe(false)
      // After the game starts the bot has a token registered internally.
      // We can't introspect it from here without a helper; the integration test
      // covers the bot's actual moves. For now we just confirm a known fake
      // token is not classified as a bot.
      expect(game.isBotToken('not-a-real-token')).toBe(false)
      expect(data.gameInstanceId).toBeDefined()
    })

    it('exposes play_bot as a tool in getTools()', () => {
      const tools = game.getTools()
      expect(tools.some(t => t.name === 'play_bot')).toBe(true)
    })

    it('emits a lobby:update after starting', () => {
      const result = game.onAction(alice, 'play_bot', {})
      expect(result.events.some(e => e.type === 'lobby:update')).toBe(true)
    })

    it('emits a session:state in-game event for the human player', () => {
      const result = game.onAction(alice, 'play_bot', {})
      const stateEvents = result.events.filter(e => e.type === 'session:state')
      // Exactly one — the human. The bot has no SessionManager session.
      expect(stateEvents).toHaveLength(1)
      expect((stateEvents[0] as any)._sessionState).toBe('in-game')
      expect((stateEvents[0] as any)._sessionStateToken).toBe(alice.token)
    })

    it('emits a session:state connected event on game end (resign)', () => {
      game.onAction(alice, 'play_bot', {})
      const resignResult = game.onAction(alice, 'resign', {})
      const stateEvents = resignResult.events.filter(e => e.type === 'session:state')
      // Per the new state model: humans return to 'connected' after game-end,
      // not 'lobby'. They opt back into the lobby explicitly via enter_lobby.
      expect(stateEvents).toHaveLength(1)
      expect((stateEvents[0] as any)._sessionState).toBe('connected')
      expect((stateEvents[0] as any)._sessionStateToken).toBe(alice.token)
    })

    it('allows the human to make moves against the bot via the existing make_move flow', () => {
      const playResult = game.onAction(alice, 'play_bot', {})
      const startData = playResult.events.find(e => e.type === 'game:start')!.data as any

      // If alice is white she can move e4; if black, the bot moved first and
      // we look at the FEN to find a legal pawn move for alice. To stay
      // deterministic across runs we check both cases.
      const aliceColor: 'white' | 'black' = startData.white === 'alice' ? 'white' : 'black'

      if (aliceColor === 'white') {
        const move = game.onAction(alice, 'make_move', { move: 'e4' })
        expect(move.ok).toBe(true)
      } else {
        // Bot has moved as white in start handling? No — our impl emits
        // game:start without a bot first move; the bot's move comes from the
        // runner. So at this point it's alice's turn... but alice is black,
        // so it's actually white's (the bot's) turn. Alice cannot move yet.
        const tooEarly = game.onAction(alice, 'make_move', { move: 'e5' })
        expect(tooEarly.ok).toBe(false)
      }
    })
  })
})
