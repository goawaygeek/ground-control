# Bot Pattern (Required for New Games)

Every game on Ground Control is expected to ship with a playable server-side
bot. Empty lobbies are the single biggest reason a first-time player bounces;
the bot is what lets them play right away instead of waiting around.

This document describes the convention and how chess implements it. New game
submissions must follow the same shape.

## Convention

Each game module should expose **a tool the LLM can call to start a match
against a bot opponent that lives entirely on the server**. The bot:

1. **Does not appear in the lobby.** It is not a `SessionManager` session and
   isn't listed in `get_lobby` or `/state.lobbyPlayers`. The LLM is responsible
   for telling the human "the lobby is empty — want to play a bot?" and then
   calling the tool.
2. **Has a stable display name.** Chess uses `chessbot`. New games should pick
   something obvious so analytics can detect bot-involved games by name.
3. **Acts via the same event channel as humans.** The bot subscribes to the
   `GameRoom`'s `onEvent` listener, watches for events that involve it, and
   responds by calling the same `onAction` handlers a human would.
4. **Defers its actions via `setImmediate`.** Bot logic must not re-enter
   `dispatchEvents` synchronously — schedule the response on the next tick so
   phase timers and listeners can finish.

## Where the pieces live (chess example)

- `src/game/chess/index.ts` — `play_bot` action and tool definition. Creates
  the game instance with the human and a synthetic bot `PlayerInfo`. Tracks
  bot tokens in a private `botTokens` set so `endGame` can clean them up.
- `src/game/chess/bot.ts` — `chooseMove(fen, rng)`. Pure function that picks
  the bot's move. Easy to unit-test against fixed positions.
- `src/game/chess/bot-runner.ts` — `ChessBotRunner`. Subscribes to the room's
  `onEvent`, tracks active bot games, and dispatches moves via `setImmediate`.
- `src/server.ts` — instantiates the runner at boot and calls `runner.start()`.

## Skill level

The first cut of a bot should be playable, not strong. Chess uses a
material-greedy heuristic (prefer captures and checks, avoid hanging pieces)
which is easy to beat for any human who knows the rules. That's the right
target — the goal is "give the new user something to do," not "challenge a
serious player." Stronger engines can come later (Stockfish.wasm is a natural
upgrade; we'll add it once we have demand).

## Why this pattern

A few alternatives were considered and rejected:

- **Bot as a real session in the lobby.** Felt like a trick on new users —
  they'd think a human was around. Also required liveness pings and
  Notion-name-collision handling.
- **Bot in a separate process / VPS.** Adds infra we don't need. Server-side
  in-process is simpler and lets the bot read the engine's FEN directly.
- **Bot housed in the client.** Interesting for a future "play offline" mode,
  but doesn't solve the empty-lobby problem (which needs the bot to be
  available the moment a user lands).

## Open source extension

Because everything is in the repo, anyone can submit a stronger bot via PR.
For chess, that means swapping the body of `chooseMove` (or adding a
`Stockfish`-backed implementation behind the same signature). For new games,
authors are expected to ship at least the random-or-heuristic baseline along
with the game module.
