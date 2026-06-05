# Player State Model

This is the spec for how Ground Control tracks where each player is at any moment. It's the source of truth for what the public endpoints report, what events fire on transitions, and what each game module is allowed to assume about its players.

It is written first; implementation follows. The current code (as of 2026-05-30) does **not** match this spec — issue #20 documents the four-stores-of-truth problem this doc is intended to replace.

## The three states

Every authenticated player on the server is in exactly one of three states at any moment:

### `connected`

> "I'm here, but I haven't committed to anything yet."

The state every player enters immediately after joining (`POST /<game>/join`). Players in this state:

- Hold a valid session token
- Can call read-only API endpoints (`get_lobby`, `get_state`, etc.)
- Can transition to `lobby` (by calling an `enter_lobby`-style action) or to `in-game` (by calling a game-starting action like `play_bot`)
- Are **not** in the lobby roster, **not** challengeable, and **not** visible in the public `/stats` count
- Are subject to the liveness sweep — `connected` is not exempt; if their client stops pinging for >90s, they get reaped

This is the state your idle MCP server sits in if the user joined but never engaged. It's where bot-game players return *after* their bot game ends if they don't want to enter the lobby.

### `lobby`

> "I'm available and listening for activity."

Reached from `connected` by an explicit per-game action. Players in this state:

- Are visible in the lobby roster (`/chess/state.lobbyPlayers`, comedy-battle's audience-waitlist)
- Can be challenged (chess) or pulled into the next round (comedy-battle)
- Receive `lobby:update`, `challenge:received`, and other lobby-scoped events
- Show up in the public `/stats` count
- Are subject to the liveness sweep

In chess this is the "I'm sitting at a table waiting for someone to want to play" state. In comedy-battle it's "I've added myself to the next-round waitlist."

### `in-game`

> "I'm engaged in a specific game right now and the platform should leave me alone."

Reached from either `connected` or `lobby` by a game-start action. Players in this state:

- Are **not** in the lobby roster — they can't be challenged
- Are bound to a specific game instance (chess game, comedy round, etc.)
- Receive game-specific events (`move:made`, `joke:submitted`, etc.)
- Show up in the public `/stats` count
- Are **exempt** from the liveness sweep (issue #8). They cannot be reaped while in-game. The sweep ignores them entirely.

When the game ends, they transition back. See "Transition: game-over" below for where they go.

## State diagram

```
                  POST /<game>/join
                          │
                          ▼
                    ┌───────────┐
                    │ connected │◀─────────────────────────┐
                    └───────────┘                          │
                       │     │                             │
            ┌──────────┘     └──────────┐                  │
            │                           │                  │
   enter_lobby action           game-start action          │
   (chess: enter_lobby)         (chess: play_bot,          │
   (comedy: enter_lobby)         comedy: ... )             │
            │                           │                  │
            ▼                           │                  │
       ┌───────┐                        │                  │
       │ lobby │                        │                  │
       └───────┘                        │                  │
            │                           │                  │
   game-start action                    │                  │
   (chess: accept_challenge,            │                  │
    comedy: round-start)                │                  │
            │                           │                  │
            └───────────────┬───────────┘                  │
                            ▼                              │
                      ┌─────────┐                          │
                      │ in-game │                          │
                      └─────────┘                          │
                            │                              │
                       game-over                           │
                            │                              │
                            └──────────────────────────────┘
                            (always back to `connected`;
                             player explicitly opts back
                             into lobby if they want to)
```

## Transitions

Each transition is **driven by a specific action or event**. There is exactly one path into each state. Game modules emit `session:state` events (the metadata channel already established by PR #9) and `GameRoom.dispatchEvents` applies them to `SessionManager`.

| Trigger | From | To | Notes |
|---|---|---|---|
| `POST /<game>/join` succeeds | (none) | `connected` | New session created in `connected` state. |
| Action: `enter_lobby` | `connected` | `lobby` | Game module emits `session:state` with `lobby` |
| Action: `play_bot` (chess) | `connected` or `lobby` | `in-game` | Bot game starts immediately |
| Action: `accept_challenge` (chess) | `lobby` | `in-game` | Both players transition |
| Action: comedy `start_round` | `lobby` | `in-game` | Whole room — competitors only? See "Comedy-battle special case" |
| Event: `game:over` (any reason) | `in-game` | `connected` | Always back to `connected`, never directly to `lobby`. Player decides to re-enter lobby explicitly. |
| Event: `game:over` while opponent left | `in-game` | `connected` | Forfeit case — surviving player also goes back to `connected`, not lobby |
| Action: `leave_lobby` | `lobby` | `connected` | Optional, but supported. Lets a player step back without disconnecting. |
| Action: `POST /<game>/leave` | any | (gone) | Full disconnect, session destroyed |
| Liveness sweep reaps | `connected` or `lobby` | (gone) | In-game sessions are exempt |

## What the public endpoints report

The big change. `/stats` and the per-game state endpoints all read from `SessionManager.state` rather than just "session exists."

### `GET /stats` (the public landing page)

```json
{
  "games": [
    { "id": "chess", "phase": "LOBBY", "lobby": 2, "inGame": 3 },
    { "id": "comedy-battle", "phase": "WRITING", "lobby": 4, "inGame": 2 }
  ]
}
```

Key changes:
- Reports `lobby` and `inGame` counts separately, not a single `players` count
- `connected` users are **not** in either count — they're private
- Removes the "1 player in LOBBY" lie when that player is actually mid-bot-game

### `GET /<game>/state`

Returns per-game state. Continues to expose `lobbyPlayers` and `activeGames` (chess) / phase-specific fields (comedy-battle), but those are derived from `SessionManager.state`, not from the game module's internal maps. Game modules no longer track their own player-state maps — they're projections of session state.

### `GET /<game>/status`

Continues to list players and their roles. Now reports the per-game role accurately (`white`, `black`, `competitor`, `audience-waitlist`, etc.) instead of always saying `audience`. See "Roles" below.

### `GET /admin/funnel` (new, optional)

Reports the `x% / y% / z% / a%` analytics question:
- Total joins
- % who reached `lobby`
- % who reached `in-game` via `play_bot`
- % who reached `in-game` via human matchmaking

Reads from the analytics event log. Auth-gated. Not on the public homepage.

## Roles

`SessionManager.role` continues to exist but its meaning sharpens:

- `connected` players have `role: 'audience'` (passive, hasn't picked a lane)
- `lobby` players have `role: 'lobby'` in chess, `role: 'audience-waitlist'` in comedy-battle, etc.
- `in-game` players have a game-specific role: `white`, `black`, `competitor`, `voter`, etc.

Roles are updated **at the same time** as state transitions, via the same `session:state` event metadata (extended to carry both `state` and `role`). No separate update mechanism.

Game modules drop their own internal player-state maps. `ChessGame.playerStates` goes away — its information is fully derivable from `SessionManager.state` + a session-level `gameInstanceId` field (added below).

## Session shape

`PlayerSession` gains one optional field:

```ts
interface PlayerSession {
  name: string
  token: string
  role: string
  state: 'connected' | 'lobby' | 'in-game'    // tightened from old binary
  gameInstanceId?: string                      // NEW: which game they're in, if any
  sseClients: Set<ServerResponse>
  disconnectTimer: NodeJS.Timeout | null
  lastPingAt: number
}
```

`gameInstanceId` is set on the same `session:state` event metadata when transitioning to `in-game`, cleared on transition back to `connected`. Game modules use `state === 'in-game'` and `gameInstanceId` to route `make_move`-style actions instead of consulting their own maps.

## Comedy-battle special case

Comedy-battle is *almost* the same shape but with one wrinkle: the lobby isn't just "waiting" — it's *participatory* (voting on jokes). So the audience-waitlist split needs care.

Working model (deferred — chess launches first; comedy-battle stays as-is for now):

- A new comedy-battle player enters `connected` like everyone else
- They can call `enter_lobby` to join the waitlist for next round → `lobby`
- They can stay in `connected` to watch without committing
- `connected` players still receive `phase:reveal`, `joke:submitted`, `vote:update` events so they can see the show — they just can't vote or be picked as next-round competitor
- When competitors are selected for the next round, they transition `lobby → in-game`
- The voting audience for the current round is the `lobby` set (waitlist members vote)

This is intentionally deferred. Chess launches first. Comedy-battle gets a follow-up PR.

## Reconnect behavior

When `POST /<game>/join` is called with an existing token:

1. Session is restored. `lastPingAt` resets.
2. **The previous `state` is preserved** — if they were `in-game`, they stay `in-game`; if `lobby`, they stay `lobby`; if `connected`, they stay `connected`. This is the fix for the bot-reap-loop bug. A respawned MCP server doesn't suddenly find itself in a different state from when it last successfully pinged.
3. If `state === 'in-game'`, the join response includes the active game's state (FEN for chess, current phase for comedy-battle, etc.) so the LLM has full context to render the current position. Game modules implement `getStateForReconnect(token)`.
4. If `state` is something the game module no longer recognizes (e.g. the game instance was already destroyed because the game ended via timeout while the player was gone), fall back to `connected`.

This is the core fix for the bot-reap loop. The old "always come back to lobby" behavior is gone.

## Analytics

State transitions are recorded. New event type:

```ts
{
  type: 'state-transition',
  game: 'chess',
  data: { name, from, to, trigger, gameInstanceId? }
}
```

Existing `player:join` continues to fire on fresh joins (`isReconnect: false`). Reconnect joins fire `state-transition` events instead — separating "new platform join" from "restored session" cleanly.

The `/admin/funnel` endpoint queries these to produce the `x%/y%/z%/a%` report.

## Liveness sweep behavior under the new model

Unchanged from PR #9's implementation, just clearer in what it does:

- Iterates every session
- Skips any session where `state === 'in-game'`
- Reaps any other session whose `lastPingAt` is older than `PING_TIMEOUT_MS` (90s)
- On reap, fires `onPlayerLeave(reason: 'reaped')` to the game module

The 90s grace period for reconnect is *implicit* — it's just the existing sweep window. A player whose client dies has 90s to come back before they're forfeited. This was your call: we have de facto grace already; no new state needed.

## Session teardown paths (all three)

There are **three** ways a session can be cleaned up, and `in-game` is exempt from two of them. Anyone adding a fourth must decide how it treats `in-game` explicitly.

| Path | Trigger | In-game treatment |
|---|---|---|
| Liveness sweep (`getSessionsToReap`) | `lastPingAt` older than 90s | **Exempt** — skipped entirely |
| SSE disconnect timer (`removeSseClient`) | last SSE client drops, 10s grace expires | **Exempt** — returns early for `in-game` (PR #24) |
| Graceful leave (`POST /<game>/leave`) | explicit user action | Forfeits the game, destroys the session |

The disconnect-timer exemption is the *real* fix for the bot-reap loop. Before it, an MCP client's routine SSE reconnect would end the live game after 10s, drop the session to `connected`, and the sweep would then reap it — the `disconnect → reaped → reconnect` loop. An MCP client reconnects constantly; the platform must not treat a dropped SSE as "left the game."

## The in-game ⟺ instance invariant

**A session in `state === 'in-game'` must always point (via `gameInstanceId`) at a game instance that still exists.** The two are created together (game-start emits `session:state in-game` alongside the instance) and destroyed together (`endGame` deletes the instance and emits `session:state connected` in the same event batch). Nothing should ever leave one without the other.

Because no automated cleanup currently ends an abandoned in-game session (chess has no turn clock — see #23), this invariant holds by construction today. But it is **fragile**: the planned #23 cleanup (a daily reap of stale game instances) **must emit the `connected` transition for the affected sessions when it destroys an instance**, or it will strand players in a broken `in-game`-pointing-at-nothing state.

**Self-heal backstop:** in case the invariant is ever violated, `ChessGame.routeToGame` detects an in-game session whose instance is missing, resets the session to `connected` (via the `session:state` event channel — game modules hold no `SessionManager` reference by design), and returns a friendly "that game has ended, start a new one" error instead of a dead-end. This is insurance, not license to break the invariant.

## What this fixes

- **Issue #20**: state lives in one place (`SessionManager`), not four. Game modules consult session state rather than maintaining parallel maps. `/stats` reports state accurately.
- **The bot-reap-loop bug**: a respawned client comes back as `in-game` (not `lobby`), so it's exempt from the sweep. No more "in lobby with no ping → reaped → rejoin → repeat" cycle.
- **The `role: audience` everywhere bug**: roles update on the same channel as state, every time.
- **The "1 player in lobby" lie**: `/stats` distinguishes lobby from in-game.

## What this doesn't fix (and explicit non-goals)

- **The MCP-server-keeps-dying upstream behavior**: this is Claude Code's lifecycle, not Ground Control's bug. We work around it via reconnect-preserving-state. If you want to investigate the MCP-side issue, it's a separate workstream.
- **Per-game custom matchmaking** beyond what chess+comedy-battle do: out of scope. The state model is general enough to support future games but doesn't try to be a framework.
- **Spectator UIs**: out of scope. The state model makes spectator UIs *possible* (a `connected` player can watch a game without polluting any roster) but the UI itself is its own PR.
- **Grace-period semantics richer than the existing sweep**: explicitly deferred. We'll see if anyone complains post-launch.

## Implementation plan (for the next session)

This doc is the spec. Implementation, in order:

1. **`SessionManager` changes**: add `connected` as a state value; add `gameInstanceId` field; add `setSessionState` helper that updates both state and `gameInstanceId` atomically.
2. **Game-room dispatchEvents change**: extend `session:state` metadata to carry the optional `gameInstanceId` and the new role.
3. **Server.ts**: `POST /join` no longer auto-adds players to lobby — they land in `connected`. Add `enter_lobby` and `leave_lobby` actions handled by `GameRoom` (not the game modules).
4. **Chess changes**: drop `playerStates` map; add `enter_lobby` handler that emits the state event; ensure `play_bot`/`accept_challenge` emit `in-game` with `gameInstanceId`; `endGame` emits `connected`.
5. **`/stats`**: switch from `getActiveSessions().length` to per-state counts via new `getSessionCountsByState()`.
6. **Reconnect path**: on `/join` with existing token, preserve `state` and `gameInstanceId`. Add `GameModule.getStateForReconnect(token)` and include its return in the join response when `state === 'in-game'`.
7. **Tests**: TDD throughout. Update prompt strings to match the new join-time flow.
8. **Migration note**: the spec says "ignore existing tokens" — sessions in flight at deploy time will land in `connected` after their next reconnect. That's fine; no users right now.
9. **Comedy-battle**: deferred. Touch only what's needed to keep it functioning under the new state model; full audience/waitlist split is a follow-up PR.

Estimated implementation effort: half a working day if no surprises. The big wins are issue #20 closing and the bot-reap loop disappearing.
