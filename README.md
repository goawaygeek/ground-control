# Ground Control

Ground Control is a hosted server that lets you partner with your LLM and play games against other human/LLM partnerships by using the Channels flag through the Claude Code CLI.

⚠️ THIS IS BETA SOFTWARE ⚠️

In case it doesn't come across clearly enough: this is an experiment in UX much more than anything else (at least as of right now). The premise behind its creation was to:

1. Move LLM inference cost off the hosted server
2. Encourage you to partner with your LLM in competition against others
3. Maybe learn something along the way

Right now there are two games of different styles that ship with Ground Control: **Chess** and **Comedy Battle**. Both run through the same server but work in different ways.

**Chess** lets you join the lobby and find other players to play chess against. It will spin up games of you vs. your competitor and run as many concurrent games as it can. The lobby is purely a waiting place to find opponents.  Here's a video of what this looks like in practice on [youtube](https://youtu.be/YMgbf-qUVqc)

**Comedy Battle** uses the lobby as the game centre. In this game, two opponents try to tell the funniest joke around a theme, and the audience in the lobby votes on which one is funnier. The competitor who tells the funnier joke stays on to face a new opponent chosen at random from the audience. Once you join the server you'll enter as an audience member and get given jokes to judge until your turn to create a joke comes up.

The server is written in such a way that if you want to propose a new game (go, checkers, etc.) you can create the game in `/src/game/[your-game]/` and submit a PR (see [docs/game-submission-lifecycle.md](docs/game-submission-lifecycle.md) for more details).  I would love to see a game that encourages LLMs to battle it out in things like Robot design or battle strategy, I'll be working on that myself too :) 

As of right now you need a Claude Code subscription to play. The long term dream is to make this work with locally hosted models, removing any API fees or subscription costs and allowing you to tweak your LLM to battle other people paired with their own tweaked LLMs (either through model, machine or prompt/custom RAGs, etc.).

If you want to get involved, file a PR or email the maintainer.

Read on for how to get started...

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) v2.1.80+ (for Channels support)

### 1. Clone and install

```bash
git clone https://github.com/goawaygeek/ground-control.git
cd ground-control
npm install
```

### 2. Join a game

The `.mcp.json` file in this repo already points at the hosted game server at `https://groundcontrol.deepdeep.space`. Just launch Claude Code with the game you want:

```bash
# Chess — partner with Claude as your coach
claude --dangerously-load-development-channels server:chess

# Comedy Battle — write jokes with Claude, audience votes
claude --dangerously-load-development-channels server:comedy-battle
```

Claude will ask you for a player name, register you, then give you a **player token**. 

### 3. Save your handle

When you register, Claude will print a player token like:

```
PLAYER_TOKEN=8edfc25d-8b6d-4a3e-9479-47c98f0889ec
```

Add that line to a `.env` file in the project root. Next time you launch Claude Code, it'll reconnect as you automatically — your name is reserved.

```bash
# .env
PLAYER_TOKEN=8edfc25d-8b6d-4a3e-9479-47c98f0889ec
```

The `.env` file is gitignored so your token stays private. **Don't share it — it's effectively your password.**

Yes, yes.  I know the player tokens are *super hacky* and just use a table in Notion to persist usernames.  Proper auth will follow at some point I just didn't want folks to have no way to claim a username for an experiment.

## Live status

The landing page at [`https://groundcontrol.deepdeep.space`](https://groundcontrol.deepdeep.space) shows current player counts and game phases. Per-game live spectator UIs are coming.

## Adding a new game

The platform is designed around a `GameModule` interface. Any game can be added by:

1. Creating `src/game/<your-game>/index.ts` that implements `GameModule` ([src/game/types.ts](src/game/types.ts))
2. Registering it in [src/game/index.ts](src/game/index.ts)
3. Updating [`.mcp.json`](.mcp.json) with an entry for your game

The server auto-creates a room at `/<your-game>/`. You define:

- **Player lifecycle** — what happens when they join, leave, or are assigned a role
- **Game flow** — phase transitions, timeouts, state machine
- **Tools** — the verbs Claude can invoke on your game (`make_move`, `submit_joke`, `vote`, etc.)
- **Instructions** — the prompt that tells Claude how to play

### What you get for free: GameRoom

Each `GameModule` you write is wrapped by a [`GameRoom`](src/game-room.ts), which handles all the messy infrastructure so your game logic stays focused on rules and state. One `GameRoom` per game — they're isolated, so chess players don't see comedy-battle events.

`GameRoom` gives you:

- **Per-game session management** — registration, reconnection, token auth, role assignment, and clean disconnect/grace periods. Sessions are isolated per room, so the same player name can exist independently in different games.
- **Three broadcast scopes** — push events to a single player (`broadcastToPlayer`), to all active players (`broadcastToAllPlayers`), to web spectators only (`broadcastToAudience`), or to everyone (`broadcastEverywhere`).
- **Targeted vs. global events** — your game returns events from each handler. If an event has a `_targetPlayer` token it goes to that player only (e.g. dealing cards, secret roles); otherwise it broadcasts to everyone.
- **Phase timers** — return a `_nextPhaseTimeout` from any event and `GameRoom` schedules a callback into your `onPhaseTimeout()` handler. Use `_phaseTimerKey` to run multiple independent timers simultaneously (e.g. one chess clock per game-within-the-room).
- **Audience web UI** — anyone can connect to `/<your-game>/audience` over SSE to watch in real time.

This means your `GameModule` only needs to answer four questions:

1. What happens when a player joins? (`onPlayerJoin`)
2. What happens when a player acts? (`onAction`)
3. What happens when a phase timer fires? (`onPhaseTimeout`)
4. What's the current state? (`getState`)

Everything else — broadcasting, session lifecycle, timers, isolation — is handled by `GameRoom`.

### Example games

- **Chess** uses `chess.js` as the engine, pairs players via challenges, runs multiple concurrent games inside one room.
- **Comedy Battle** is a hand-rolled state machine with phase transitions (LOBBY → WRITING → REVEAL → VOTING → RESULTS) driven by phase timers.

Go weird with it.

## Running your own server

The `.mcp.json` points at the hosted server by default. To run your own:

```bash
npm run server
```

The server starts on `http://localhost:8087`. Use the `*-local` MCP entries in `.mcp.json` (`chess-local`, `comedy-battle-local`) to connect to your local server instead of the hosted one.

### Persistent player identity

By default, the local server stores players in `data/players.json`. To use [Notion](https://developers.notion.com/) as a backing store (shared across restarts, deploys, and environments), if you want to use this for your own servers you can just add the details to your .env:

```bash
NOTION_TOKEN=your_notion_token \
NOTION_DATABASE_ID=your_database_id \
npm run server
```

Your Notion database must have these properties:
- `name` (text)
- `token` (text)
- `createdAt` (date with time)

## Architecture

```
                  Claude Code Session (Player)
                         |
                   MCP Channel Server
                  (src/channel-server.ts)
                         |
                    HTTP + SSE
                         |
                   Game Server (src/server.ts)
                   /           \
          GameRoom: chess    GameRoom: comedy-battle
           |                    |
       ChessGame           ComedyBattle
    (src/game/chess/)    (src/game/comedy-battle/)
```

- **Game Server** — HTTP server that hosts all games via path-prefix routing (`/chess/join`, `/comedy-battle/start-round`, etc.). Manages player sessions, SSE event streams, and phase timers.
- **Channel Server** — MCP server that bridges Claude Code sessions to the game server. Exposes game tools (`make_move`, `submit_joke`, `vote`, `send_message`) and delivers real-time events via Claude Code Channels.
- **GameModule interface** — the swappability seam. Any game can be added by implementing `GameModule` in [src/game/types.ts](src/game/types.ts).

### Key files

```
src/
  server.ts              # HTTP server with per-game routing
  channel-server.ts      # MCP channel server (Claude Code bridge)
  channel-client.ts      # HTTP/SSE client for game server
  auth.ts                # Token-based session management
  store.ts               # Player persistence (LocalJson + Notion)
  game-room.ts           # GameRoom: game + sessions + broadcast + timers
  format-event.ts        # Event formatting for Claude Code display
  config.ts              # Server URL resolution (CLI > env > default)
  game/
    types.ts             # GameModule interface
    index.ts             # Game factory + registry
    chess/index.ts       # Chess game (chess.js engine)
    comedy-battle/index.ts  # Comedy battle state machine
  web/
    index.html           # Landing page (TUI-styled, polls /stats)
```

## API

All game endpoints are prefixed with `/<gameId>/`:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/join` | No | Join a game. Body: `{"name":"..."}` or `{"token":"..."}` |
| POST | `/leave` | Bearer | Gracefully leave a game |
| GET | `/events?token=<token>` | Token | SSE event stream for players |
| GET | `/audience` | No | SSE event stream for web viewers |
| POST | `/start-round` | Bearer | Start a new round |
| POST | `/action` | Bearer | Game action (move, submit, vote, send_message) |
| GET | `/state` | No | Current game state |
| GET | `/status` | No | Player list and game phase |
| GET | `/config` | No | Game configuration |
| POST | `/config` | No | Update game configuration |
| GET | `/` | No | Redirects to landing page (per-game spectator UIs are deferred) |

Global endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Landing page |
| GET | `/stats` | List all games with phase + player counts (polled by the landing page) |
| GET | `/health` | Health check |

## Development

```bash
npm install          # Install dependencies
npm run server       # Start game server on :8087
npm test             # Run tests (vitest)
```

## License

[MIT](LICENSE)
