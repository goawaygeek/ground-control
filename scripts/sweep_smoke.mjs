// Manual smoke test for issue #8 — verifies that in-game players are not
// reaped by the liveness sweep, and that they ARE eligible again once the
// game ends. Run with: npx tsx scripts/sweep_smoke.mjs

import { GameRoom } from '../src/game-room.ts'
import { ChessGame } from '../src/game/chess/index.ts'
import { ChessBotRunner } from '../src/game/chess/bot-runner.ts'

const room = new GameRoom(new ChessGame())
new ChessBotRunner(room, () => 0.5).start()

const alice = await room.sessions.joinPlayer('alice')
if (!alice.ok) throw new Error('join failed')
room.dispatchEvents(room.game.onPlayerJoin({ name: 'alice', token: alice.token, role: 'audience' }))

const r = room.game.onAction({ name: 'alice', token: alice.token, role: 'lobby' }, 'play_bot', {})
room.dispatchEvents(r.events)

const session = room.sessions.getSessionByToken(alice.token)
console.log(`session.state before sweep: ${session.state}`)
session.lastPingAt = 0

const toReap = room.sessions.getSessionsToReap(Date.now(), 90_000)
console.log(`getSessionsToReap returned: ${toReap.length} (expected 0)`)
if (toReap.length === 0) console.log('PASS: in-game player not reaped')
else { console.log('FAIL: in-game player was reaped'); process.exit(1) }

const resignResult = room.game.onAction({ name: 'alice', token: alice.token, role: 'white' }, 'resign', {})
room.dispatchEvents(resignResult.events)
console.log(`session.state after resign: ${session.state}`)

session.lastPingAt = 0
const toReapAfter = room.sessions.getSessionsToReap(Date.now(), 90_000)
console.log(`getSessionsToReap after resign+silence: ${toReapAfter.length} (expected 1)`)
if (toReapAfter.length === 1 && toReapAfter[0].name === 'alice') console.log('PASS: round-trip works')
else { console.log('FAIL: round-trip broken'); process.exit(1) }

process.exit(0)
