import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGame, getAvailableGames } from './game/index.js'
import { GameRoom } from './game-room.js'
import { NotionPlayerStore, LocalJsonStore } from './store.js'
import { LocalJsonlEventStore, NotionEventStore, type EventStore } from './event-store.js'
import { Analytics } from './analytics.js'
import { ChessBotRunner } from './game/chess/bot-runner.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.PORT ?? '8087', 10)

// --- Shared player store (persistent identity across all games) ---
let playerStore
if (process.env.NOTION_TOKEN && process.env.NOTION_DATABASE_ID) {
  playerStore = new NotionPlayerStore(process.env.NOTION_DATABASE_ID, process.env.NOTION_TOKEN)
  console.log('Using Notion for player persistence')
} else {
  const storePath = join(__dirname, '..', 'data', 'players.json')
  playerStore = new LocalJsonStore(storePath)
  console.log('Using local JSON file for player persistence')
}

// --- Create a GameRoom for each available game ---
const rooms = new Map<string, GameRoom>()
for (const gameId of getAvailableGames()) {
  rooms.set(gameId, new GameRoom(createGame(gameId), playerStore))
}

// --- Analytics (Notion if configured, JSONL fallback) ---
let eventStore: EventStore
if (process.env.NOTION_TOKEN && process.env.NOTION_ANALYTICS_DATABASE_ID) {
  eventStore = new NotionEventStore(process.env.NOTION_ANALYTICS_DATABASE_ID, process.env.NOTION_TOKEN)
  console.log('Using Notion for analytics events')
} else {
  const eventsPath = join(__dirname, '..', 'data', 'events.jsonl')
  eventStore = new LocalJsonlEventStore(eventsPath)
  console.log(`Using local JSONL file for analytics events (${eventsPath})`)
}
const analytics = new Analytics(eventStore)
for (const room of rooms.values()) {
  analytics.subscribe(room)
}

// --- Chess bot (server-side, hidden from lobby) ---
const chessRoom = rooms.get('chess')
if (chessRoom && process.env.CHESSBOT_ENABLED !== 'false') {
  const runner = new ChessBotRunner(chessRoom)
  runner.start()
  console.log('Chess bot enabled — humans can invoke it via play_bot')
}

function resolveRoom(pathname: string): { room: GameRoom; subpath: string } | null {
  // Match /<gameId>/... pattern
  const match = pathname.match(/^\/([^/]+)(.*)$/)
  if (!match) return null

  const [, gameId, rest] = match
  const room = rooms.get(gameId)
  if (!room) return null

  return { room, subpath: rest || '/' }
}

// --- HTTP Helpers ---
const MAX_BODY_BYTES = 64 * 1024 // 64 KB — generous ceiling for game payloads

type ReadBodyResult = { ok: true; body: string } | { ok: false; tooLarge: true }

function readBody(req: IncomingMessage): Promise<ReadBodyResult> {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        aborted = true
        req.destroy()
        resolve({ ok: false, tooLarge: true })
        return
      }
      body += chunk.toString()
    })
    req.on('end', () => {
      if (!aborted) resolve({ ok: true, body })
    })
    req.on('error', (err) => {
      if (!aborted) reject(err)
    })
  })
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(data))
}

// --- Server ---
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`)

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    })
    res.end()
    return
  }

  // --- GET /health ---
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true })
  }

  // --- GET / (landing page) ---
  if (req.method === 'GET' && url.pathname === '/') {
    try {
      const html = readFileSync(join(__dirname, 'web', 'index.html'), 'utf-8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Landing page not found.')
    }
    return
  }

  // --- GET /stats (aggregated live counters for the landing page) ---
  // Reports lobby and in-game counts separately per docs/player-state.md.
  // 'connected' players are private — not surfaced on the public landing page.
  if (req.method === 'GET' && url.pathname === '/stats') {
    const games = getAvailableGames().map(id => {
      const room = rooms.get(id)!
      const counts = room.sessions.getSessionCountsByState()
      return {
        id,
        phase: room.game.getPhase(),
        // Legacy: total session count (preserved for old landing page polls).
        players: counts.connected + counts.lobby + counts['in-game'],
        // New fields per the state model:
        lobby: counts.lobby,
        inGame: counts['in-game'],
      }
    })
    return json(res, 200, { games })
  }

  // --- Resolve game room from path prefix ---
  const resolved = resolveRoom(url.pathname)
  if (!resolved) {
    return json(res, 404, { error: 'Not found. Available games: ' + getAvailableGames().join(', ') })
  }

  const { room, subpath } = resolved

  // --- POST /<game>/join ---
  if (req.method === 'POST' && subpath === '/join') {
    const bodyResult = await readBody(req)
    if (!bodyResult.ok) return json(res, 413, { error: 'Request body too large' })
    let parsed: { name?: string; token?: string }
    try {
      parsed = JSON.parse(bodyResult.body)
    } catch {
      return json(res, 400, { error: 'Invalid JSON' })
    }

    const { name, token } = parsed

    let result
    if (token && typeof token === 'string') {
      // Token-based reconnect
      result = await room.sessions.joinPlayerByToken(token)
    } else if (name && typeof name === 'string' && name.trim().length > 0) {
      // Name-based join
      result = await room.sessions.joinPlayer(name.trim())
    } else {
      return json(res, 400, { error: 'Provide "name" to register or "token" to reconnect' })
    }

    if (!result.ok) {
      return json(res, result.error.includes('Invalid token') ? 401 : 409, { error: result.error })
    }

    console.log(`[${room.game.gameId}] ${result.name} joined${result.isReconnect ? ' (reconnect)' : ''} — token: ${result.token.slice(0, 8)}...`)

    // Fresh sessions land in 'connected' state per docs/player-state.md.
    // Reconnects preserve whatever state they had — including 'in-game' so a
    // mid-game reconnect lands the player back in their existing game.
    const session = room.sessions.getSessionByToken(result.token)!

    analytics.recordJoin({
      game: room.game.gameId,
      name: result.name,
      isReconnect: result.isReconnect,
    })

    return json(res, 200, {
      token: result.token,
      name: result.name,
      state: session.state,
      gameInstanceId: session.gameInstanceId,
    })
  }

  // --- GET /<game>/events?token=<token> (Player SSE) ---
  if (req.method === 'GET' && subpath === '/events') {
    const token = url.searchParams.get('token')
    if (!token) {
      return json(res, 400, { error: 'Missing ?token= parameter' })
    }

    const session = room.sessions.getSessionByToken(token)
    if (!session) {
      return json(res, 401, { error: 'Invalid token' })
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })

    res.write(`event: connected\ndata: ${JSON.stringify({
      name: session.name,
      role: session.role,
      gameState: room.game.getState(),
    })}\n\n`)

    room.sessions.addSseClient(session, res)
    console.log(`[${room.game.gameId}] ${session.name} connected (${session.sseClients.size} connections)`)

    let cleanedUp = false
    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      room.sessions.removeSseClient(session, res, (disconnectedSession) => {
        console.log(`[${room.game.gameId}] ${disconnectedSession.name} disconnected (grace period expired)`)
        const events = room.game.onPlayerLeave({
          name: disconnectedSession.name,
          token: disconnectedSession.token,
          role: disconnectedSession.role,
        }, 'disconnect')
        room.dispatchEvents(events)
      })
      console.log(`[${room.game.gameId}] ${session.name} connection closed (${session.sseClients.size} remaining)`)
    }

    // Cover all the ways a client can go away: clean close, socket error,
    // and our own res.end() (e.g. from /leave or a failed heartbeat write).
    req.on('close', cleanup)
    req.on('error', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)

    return
  }

  // --- POST /<game>/start-round ---
  if (req.method === 'POST' && subpath === '/start-round') {
    const session = room.sessions.authenticate(req)
    if (!session) return json(res, 401, { error: 'Unauthorized' })

    // Only lobby-state players are eligible to compete. Connected sessions
    // haven't opted in.
    const players = room.sessions.getActiveSessions()
      .filter(s => s.state === 'lobby')
      .map(s => ({
        name: s.name,
        token: s.token,
        role: s.role,
      }))

    if (!room.game.canStartGame(players)) {
      return json(res, 400, { error: `Cannot start game (phase: ${room.game.getPhase()}, players: ${players.length})` })
    }

    const events = room.game.startRound(players)
    const roles = room.game.getRoleAssignments(players)
    for (const [token, role] of roles) {
      room.sessions.setRole(token, role)
    }

    room.dispatchEvents(events)
    const state = room.game.getState()
    console.log(`[${room.game.gameId}] Started round ${state.roundNumber}: "${state.theme}"`)

    return json(res, 200, { ok: true, ...state })
  }

  // --- POST /<game>/action ---
  if (req.method === 'POST' && subpath === '/action') {
    const session = room.sessions.authenticate(req)
    if (!session) return json(res, 401, { error: 'Unauthorized' })

    const bodyResult = await readBody(req)
    if (!bodyResult.ok) return json(res, 413, { error: 'Request body too large' })
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(bodyResult.body)
    } catch {
      return json(res, 400, { error: 'Invalid JSON' })
    }

    const { action, ...data } = parsed
    if (!action || typeof action !== 'string') {
      return json(res, 400, { error: 'Missing "action" field' })
    }

    // Game-agnostic actions handled at the room level
    if (action === 'send_message') {
      const message = data.message
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return json(res, 400, { error: 'Missing or empty "message" field' })
      }
      room.handleMessage(
        { name: session.name, token: session.token, role: session.role },
        message.trim(),
      )
      console.log(`[${room.game.gameId}] ${session.name}: message`)
      return json(res, 200, { ok: true })
    }

    if (action === 'enter_lobby') {
      const enterResult = room.handleEnterLobby(
        { name: session.name, token: session.token, role: session.role },
      )
      if (!enterResult.ok) return json(res, 400, { error: enterResult.error })
      console.log(`[${room.game.gameId}] ${session.name}: enter_lobby`)
      return json(res, 200, { ok: true })
    }

    if (action === 'leave_lobby') {
      const leaveResult = room.handleLeaveLobby(
        { name: session.name, token: session.token, role: session.role },
      )
      if (!leaveResult.ok) return json(res, 400, { error: leaveResult.error })
      console.log(`[${room.game.gameId}] ${session.name}: leave_lobby`)
      return json(res, 200, { ok: true })
    }

    const result = room.game.onAction(
      {
        name: session.name,
        token: session.token,
        role: session.role,
        state: session.state,
        gameInstanceId: session.gameInstanceId,
      },
      action,
      data,
    )

    if (!result.ok) {
      return json(res, 400, { error: result.error })
    }

    room.dispatchEvents(result.events)
    console.log(`[${room.game.gameId}] ${session.name}: ${action}`)

    return json(res, 200, { ok: true, ...(result.responseData ?? {}) })
  }

  // --- POST /<game>/leave ---
  if (req.method === 'POST' && subpath === '/leave') {
    const session = room.sessions.authenticate(req)
    if (!session) return json(res, 401, { error: 'Unauthorized' })

    const playerInfo = { name: session.name, token: session.token, role: session.role }

    // Close all active SSE connections for this player
    for (const sseRes of session.sseClients) {
      sseRes.end()
    }
    session.sseClients.clear()

    room.sessions.removePlayer(session.token)
    const events = room.game.onPlayerLeave(playerInfo, 'graceful')
    room.dispatchEvents(events)

    console.log(`[${room.game.gameId}] ${session.name} left`)
    return json(res, 200, { ok: true })
  }

  // --- POST /<game>/ping (client liveness signal) ---
  // Cloud Run holds half-open SSE connections after the client disappears,
  // so the server can't reliably detect disconnects from socket state alone.
  // Clients POST here every ~30s; sessions whose lastPingAt is too stale
  // get reaped by the sweep below.
  if (req.method === 'POST' && subpath === '/ping') {
    const session = room.sessions.authenticate(req)
    if (!session) return json(res, 401, { error: 'Unauthorized' })
    room.sessions.markAlive(session.token)
    return json(res, 200, { ok: true })
  }

  // --- GET /<game>/state ---
  if (req.method === 'GET' && subpath === '/state') {
    const players = room.sessions.getActiveSessions().map(s => ({ name: s.name, role: s.role }))
    return json(res, 200, { ...room.game.getState(), players })
  }

  // --- GET /<game>/audience (Web UI SSE) ---
  if (req.method === 'GET' && subpath === '/audience') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    res.write(`event: connected\ndata: ${JSON.stringify({
      message: 'Connected to audience feed',
      gameState: room.game.getState(),
      players: room.sessions.getActiveSessions().map(s => ({ name: s.name, role: s.role })),
    })}\n\n`)

    room.audienceClients.add(res)
    const audienceCleanup = () => room.audienceClients.delete(res)
    req.on('close', audienceCleanup)
    req.on('error', audienceCleanup)
    res.on('close', audienceCleanup)
    res.on('error', audienceCleanup)
    return
  }

  // --- GET /<game>/ — per-game spectator UI (deferred). Redirect to landing. ---
  if (req.method === 'GET' && (subpath === '/' || subpath === '/index.html')) {
    res.writeHead(302, { Location: '/' })
    res.end()
    return
  }

  // --- POST /<game>/config ---
  if (req.method === 'POST' && subpath === '/config') {
    const bodyResult = await readBody(req)
    if (!bodyResult.ok) return json(res, 413, { error: 'Request body too large' })
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(bodyResult.body)
    } catch {
      return json(res, 400, { error: 'Invalid JSON' })
    }

    room.game.setConfig(parsed)
    const updated = room.game.getConfig()
    console.log(`[${room.game.gameId}] Config updated:`, updated)
    return json(res, 200, { ok: true, config: updated })
  }

  // --- GET /<game>/config ---
  if (req.method === 'GET' && subpath === '/config') {
    return json(res, 200, { config: room.game.getConfig() })
  }

  // --- GET /<game>/status ---
  if (req.method === 'GET' && subpath === '/status') {
    const sessions = room.sessions.getActiveSessions()
    return json(res, 200, {
      players: sessions.map(s => ({ name: s.name, role: s.role, connections: s.sseClients.size })),
      totalPlayers: sessions.length,
      gamePhase: room.game.getPhase(),
    })
  }

  // 404 within game namespace
  json(res, 404, { error: 'Not found' })
})

// Heartbeat every 30 seconds
setInterval(() => {
  for (const room of rooms.values()) {
    room.sendHeartbeat()
  }
}, 30_000)

// Liveness sweep every 30 seconds — reap sessions whose client hasn't pinged
// in PING_TIMEOUT_MS. Catches Cloud Run's half-open SSE connections.
// In-game sessions are exempt (see issue #8) — they're protected by the
// opponent's interest in the game and have their own forfeit logic.
const PING_TIMEOUT_MS = 90_000
setInterval(() => {
  const now = Date.now()
  for (const [gameId, room] of rooms) {
    for (const session of room.sessions.getSessionsToReap(now, PING_TIMEOUT_MS)) {
      const playerInfo = { name: session.name, token: session.token, role: session.role }

      // Close any lingering SSE connections so they don't pile up
      for (const sseRes of session.sseClients) {
        try { sseRes.end() } catch { /* swallow */ }
      }
      session.sseClients.clear()

      room.sessions.removePlayer(session.token)
      const events = room.game.onPlayerLeave(playerInfo, 'reaped')
      room.dispatchEvents(events)

      console.log(`[${gameId}] ${session.name} reaped (no ping in ${Math.round((now - session.lastPingAt) / 1000)}s)`)
    }
  }
}, 30_000)

server.listen(PORT, () => {
  console.log(`Game server running on http://localhost:${PORT}`)
  console.log(`  Games:`)
  for (const gameId of getAvailableGames()) {
    console.log(`    /${gameId}/  — ${gameId}`)
  }
  console.log(`  Health:      GET  /health`)
  console.log(`  Game list:   GET  /`)
  console.log()
  console.log(`  Per-game routes (prefix with /<gameId>):`)
  console.log(`    Join:        POST /join`)
  console.log(`    SSE:         GET  /events?token=<token>`)
  console.log(`    Audience:    GET  /audience`)
  console.log(`    Start round: POST /start-round  (auth required)`)
  console.log(`    Action:      POST /action        (auth required)`)
  console.log(`    State:       GET  /state`)
  console.log(`    Config:      GET  /config`)
  console.log(`    Status:      GET  /status`)
})
