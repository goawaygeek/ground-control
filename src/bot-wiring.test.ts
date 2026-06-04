import { describe, it, expect } from 'vitest'
import { GameRoom } from './game-room.js'
import { ChessGame, CHESS_BOT_NAME } from './game/chess/index.js'
import { ChessBotRunner } from './game/chess/bot-runner.js'

async function flushImmediate(): Promise<void> {
  await new Promise(setImmediate)
}

describe('ChessBotRunner end-to-end', () => {
  it('plays a full game against a human via play_bot until game:over', async () => {
    const room = new GameRoom(new ChessGame())
    // Deterministic RNG so a test run is reproducible.
    let counter = 0
    const runner = new ChessBotRunner(room, () => ((counter++ * 0.13) % 1))
    runner.start()

    const alice = await room.sessions.joinPlayer('alice')
    if (!alice.ok) throw new Error('join failed')
    room.dispatchEvents(room.game.onPlayerJoin({ name: 'alice', token: alice.token, role: 'audience' }))

    // Start the bot game.
    const playResult = room.game.onAction(
      { name: 'alice', token: alice.token, role: 'lobby' },
      'play_bot',
      {},
    )
    room.dispatchEvents(playResult.events)

    // Drive the game: alice makes moves whenever it's her turn; the bot moves
    // automatically via the runner. Loop is bounded to avoid runaway games.
    const chessGame = room.game as ChessGame
    const startData = playResult.events.find(e => e.type === 'game:start')!.data as any
    const aliceColor: 'white' | 'black' = startData.white === 'alice' ? 'white' : 'black'

    let gameOver = false
    const eventStream: string[] = []
    room.onEvent((evt) => {
      eventStream.push(evt.type)
      if (evt.type === 'game:over') gameOver = true
    })

    for (let ply = 0; ply < 200 && !gameOver; ply++) {
      await flushImmediate()
      if (gameOver) break

      // Find the active instance and figure out whose turn it is.
      const instance = chessGame.getInstanceById(startData.gameInstanceId)
      if (!instance) break

      const turn = instance.engine.turn() === 'w' ? 'white' : 'black'
      if (turn === aliceColor) {
        // Alice plays the first legal move.
        const legal = instance.engine.moves()
        if (legal.length === 0) break
        const result = room.game.onAction(
          { name: 'alice', token: alice.token, role: aliceColor },
          'make_move',
          { move: legal[0] },
        )
        room.dispatchEvents(result.events)
      } else {
        // It's the bot's turn — wait for setImmediate to flush the runner's move.
        await flushImmediate()
      }
    }

    expect(gameOver).toBe(true)
    expect(eventStream).toContain('game:over')
    // After the game ends, per the new state model alice goes to 'connected'
    // (not lobby). She'd call enter_lobby explicitly to rejoin the lobby.
    const state = room.game.getState() as any
    expect(state.lobbyPlayers).not.toContain('alice')
    expect(state.lobbyPlayers).not.toContain(CHESS_BOT_NAME)
    expect(state.activeGames).toHaveLength(0)
  })

  it('does not act on game:start when bot is not a participant', async () => {
    // Two humans game — bot runner should ignore their game.
    const room = new GameRoom(new ChessGame())
    const runner = new ChessBotRunner(room, () => 0)
    runner.start()

    const alice = await room.sessions.joinPlayer('alice')
    const bob = await room.sessions.joinPlayer('bob')
    if (!alice.ok || !bob.ok) throw new Error('join failed')
    room.dispatchEvents(room.game.onPlayerJoin({ name: 'alice', token: alice.token, role: 'audience' }))
    room.dispatchEvents(room.game.onPlayerJoin({ name: 'bob', token: bob.token, role: 'audience' }))

    const challenge = room.game.onAction(
      { name: 'alice', token: alice.token, role: 'lobby' },
      'challenge',
      { opponent: 'bob' },
    )
    room.dispatchEvents(challenge.events)
    const challengeId = (challenge.events.find(e => e.type === 'challenge:sent')!.data as any).challengeId

    const accept = room.game.onAction(
      { name: 'bob', token: bob.token, role: 'lobby' },
      'accept_challenge',
      { challengeId },
    )
    room.dispatchEvents(accept.events)

    await flushImmediate()
    await flushImmediate()

    // No move should have been made — both humans haven't moved yet.
    const startData = accept.events.find(e => e.type === 'game:start')!.data as any
    const chessGame = room.game as ChessGame
    const instance = chessGame.getInstanceById(startData.gameInstanceId)!
    expect(instance.engine.history()).toHaveLength(0)
  })
})
