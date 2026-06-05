import { Chess } from 'chess.js'
import { randomUUID } from 'node:crypto'
import type { GameModule, GameEvent, PlayerInfo, ActionResult, McpToolDef, LeaveReason } from '../types.js'

// Turn clock is intentionally absent for beta — see #10 for the design
// conversation about how to bring it back properly (per-game configuration,
// separating abandonment cleanup from move pressure, bot games exempt, etc.).
// Removing it for now closes a class of UX bugs where players got forfeited
// while collaborating with their LLM on a move.

interface Challenge {
  id: string
  challenger: PlayerInfo
  opponent: PlayerInfo
  challengerColor?: 'white' | 'black' | 'random'
}

interface ChessGameInstance {
  id: string
  engine: Chess
  whitePlayer: PlayerInfo
  blackPlayer: PlayerInfo
}

export const CHESS_BOT_NAME = 'chessbot'

export class ChessGame implements GameModule {
  readonly gameId = 'chess'

  private instances = new Map<string, ChessGameInstance>()
  private challenges = new Map<string, Challenge>()
  /**
   * Token → gameInstanceId for any player currently in a game (humans + bots).
   * Replaces the old playerStates map. For human players this duplicates
   * session.gameInstanceId, but we still need the map because (a) the
   * server-side bot has no session, (b) we need to look up the opponent's
   * in-game status without holding a session manager reference. See
   * docs/player-state.md.
   */
  private inGameInstances = new Map<string, string>()
  private playersByToken = new Map<string, PlayerInfo>()
  private botTokens = new Set<string>()

  isBotToken(token: string): boolean {
    return this.botTokens.has(token)
  }

  getInstanceById(gameInstanceId: string): ChessGameInstance | null {
    return this.instances.get(gameInstanceId) ?? null
  }

  // --- GameModule interface ---

  getPhase(): string {
    return 'LOBBY'
  }

  getState(): Record<string, unknown> {
    return {
      phase: 'LOBBY',
      lobbyPlayers: this.getLobbyPlayerNames(),
      activeGames: this.getActiveGameSummaries(),
      pendingChallenges: this.getPendingChallengeSummaries(),
    }
  }

  /**
   * Called by GameRoom.handleEnterLobby (NOT by HTTP /join — per the new state
   * model, joining the server is separate from joining the lobby). Adds the
   * player to the lobby roster.
   */
  onPlayerJoin(player: PlayerInfo): GameEvent[] {
    this.playersByToken.set(player.token, player)
    return [
      { type: 'player:joined', data: { name: player.name } },
      { type: 'lobby:update', data: this.getLobbyData() },
    ]
  }

  /**
   * Called when a player leaves — either by leaving the lobby (reason
   * 'left_lobby') or by disconnecting from the server entirely (other reasons).
   */
  onPlayerLeave(player: PlayerInfo, reason: LeaveReason): GameEvent[] {
    const events: GameEvent[] = [
      { type: 'player:left', data: { name: player.name, reason } },
    ]

    // If they're in a game, forfeit it (unless they're just leaving the lobby —
    // by definition they can't be in a game in that case, since handleLeaveLobby
    // rejects mid-game leaves).
    const gameInstanceId = this.inGameInstances.get(player.token)
    if (gameInstanceId) {
      const instance = this.instances.get(gameInstanceId)
      if (instance) {
        const opponent = instance.whitePlayer.token === player.token
          ? instance.blackPlayer
          : instance.whitePlayer
        events.push(...this.endGame(instance, 'forfeit', opponent.name, player.name))
      }
    }

    // Cancel any challenges involving this player.
    for (const [id, challenge] of this.challenges) {
      if (challenge.challenger.token === player.token || challenge.opponent.token === player.token) {
        this.challenges.delete(id)
        const otherPlayer = challenge.challenger.token === player.token
          ? challenge.opponent
          : challenge.challenger
        events.push({
          type: 'challenge:cancelled',
          data: { challengeId: id, reason: `${player.name} left` },
          _targetPlayer: otherPlayer.token,
        })
      }
    }

    this.playersByToken.delete(player.token)
    events.push({ type: 'lobby:update', data: this.getLobbyData() })
    return events
  }

  canStartGame(_players: PlayerInfo[]): boolean {
    return false // Use challenges instead
  }

  startRound(_players: PlayerInfo[]): GameEvent[] {
    return [] // No-op — use challenges
  }

  onAction(player: PlayerInfo, action: string, data: unknown): ActionResult {
    switch (action) {
      case 'challenge':
        return this.handleChallenge(player, data)
      case 'accept_challenge':
        return this.handleAcceptChallenge(player, data)
      case 'decline_challenge':
        return this.handleDeclineChallenge(player, data)
      case 'get_lobby':
        return this.handleGetLobby(player)
      case 'play_bot':
        return this.handlePlayBot(player)
      case 'make_move':
        return this.routeToGame(player, (instance) => this.handleMove(instance, player, data))
      case 'get_board':
        return this.routeToGame(player, (instance) => this.handleGetBoard(instance, player))
      case 'resign':
        return this.routeToGame(player, (instance) => this.handleResign(instance, player))
      default:
        return { ok: false, error: `Unknown action: ${action}`, events: [] }
    }
  }

  // No phase timers in beta — interface method required by GameModule but
  // chess no longer schedules any. See #10.
  onPhaseTimeout(_timerKey?: string): GameEvent[] {
    return []
  }

  getTools(): McpToolDef[] {
    return [
      {
        name: 'challenge',
        description: 'Challenge another player to a chess game',
        inputSchema: {
          type: 'object',
          properties: {
            opponent: { type: 'string', description: 'Name of the player to challenge' },
            color: { type: 'string', enum: ['white', 'black', 'random'], description: 'Your preferred color (default: random)' },
          },
          required: ['opponent'],
        },
      },
      {
        name: 'accept_challenge',
        description: 'Accept a pending challenge from another player',
        inputSchema: {
          type: 'object',
          properties: {
            challengeId: { type: 'string', description: 'The challenge ID to accept' },
          },
          required: ['challengeId'],
        },
      },
      {
        name: 'decline_challenge',
        description: 'Decline a pending challenge from another player',
        inputSchema: {
          type: 'object',
          properties: {
            challengeId: { type: 'string', description: 'The challenge ID to decline' },
          },
          required: ['challengeId'],
        },
      },
      {
        name: 'get_lobby',
        description: 'See who is in the lobby, pending challenges, and active games',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'play_bot',
        description: 'Start a game against a server-side chess bot. Use this when the lobby is empty and the human wants to play immediately.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'make_move',
        description: 'Make a chess move in standard algebraic notation (e.g. "e4", "Nf3", "O-O", "exd5")',
        inputSchema: {
          type: 'object',
          properties: {
            move: { type: 'string', description: 'The move in algebraic notation' },
          },
          required: ['move'],
        },
      },
      {
        name: 'get_board',
        description: 'Show the current board position, legal moves, and whose turn it is',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'resign',
        description: 'Resign the current game',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ]
  }

  getInstructions(): string {
    return [
      `You are playing Chess as a coach/advisor for your human partner.`,
      ``,
      `JOINING:`,
      `- When you first connect, you are NOT in the lobby yet. You're just connected to the server.`,
      `- Ask the human: do they want to play another human (call enter_lobby first, then challenge or wait for challenges) or play the server bot (call play_bot immediately)?`,
      `- You can call get_lobby at any time to see who's in the lobby and if anyone is around.`,
      ``,
      `LOBBY (after enter_lobby):`,
      `- Once in the lobby, you're visible to other players and challengeable.`,
      `- To play a human, use the challenge tool with their name.`,
      `- If someone challenges you, you'll receive a challenge:received event. Discuss with your human and use accept_challenge or decline_challenge.`,
      `- Once a challenge is accepted, the game starts automatically.`,
      `- If you want to step out of the lobby without leaving the server, call leave_lobby.`,
      ``,
      `PLAYING A BOT:`,
      `- play_bot starts a game immediately against the server bot. Works whether or not you've entered the lobby.`,
      `- Do not surface the bot as a lobby player; the bot only appears as your opponent in active games.`,
      `- Mention that the human can call play_bot again any time.`,
      ``,
      `DURING A GAME:`,
      `- ALWAYS draw the board for the human. Render it on the very first turn, before and after every move, and any time you discuss the position. Never just list moves without showing the board — the human is looking at the board, not reading notation.`,
      `- Call get_board to fetch the current position; it returns the board as ASCII plus the legal moves. Show that board in a code block to the human every time, then talk about it.`,
      `- Analyze the position: what are the threats? What are the opportunities?`,
      `- Suggest 2-3 candidate moves with brief explanations.`,
      `- Let the human pick — then call make_move with their choice.`,
      `- NEVER make a move without the human's agreement.`,
      `- Use resign if your human wants to give up.`,
      ``,
      `RENDERING MOVES (CRITICAL):`,
      `- make_move returns the resulting board, FEN, and turn in its tool response. Use ONLY that data to render the board after the human's move. Do NOT imagine, infer, or fabricate a board from your own reasoning.`,
      `- The bot's reply (or another player's move) arrives as a separate move:made event. Wait for it. Do NOT narrate or render an opponent move until the event actually arrives.`,
      `- If make_move returns an error (illegal move, not your turn, etc.), tell the human exactly what the server said. Do NOT pretend the move succeeded.`,
      ``,
      `AFTER A GAME:`,
      `- You return to the 'connected' state — not back in the lobby automatically.`,
      `- Ask the human: play another bot? Enter the lobby to find a human? Or step away?`,
      ``,
      `MOVES: Use standard algebraic notation:`,
      `- Pawn moves: e4, d5, exd5 (capture)`,
      `- Piece moves: Nf3 (knight), Bb5 (bishop), Qd1 (queen), Rfe1 (rook)`,
      `- Castling: O-O (kingside), O-O-O (queenside)`,
      `- Promotion: e8=Q`,
      ``,
      `DISPLAYING THE BOARD:`,
      `- ALWAYS display the board to the user — on game:start, move:made, and game:over events, AND whenever you call get_board (e.g. when the human first opens the game or asks "what's the position?"). Showing the board is the default, not the exception.`,
      `- The board is formatted as ASCII art — show it in a code block so it renders clearly.`,
      `- After each move, briefly note what happened (e.g. "Alice played e4") and show the board.`,
      ``,
      `KEY EVENTS:`,
      `- "challenge:received": Someone wants to play you! Shows challenger name and challengeId.`,
      `- "challenge:accepted": Your challenge was accepted. Game starting!`,
      `- "challenge:declined": Your challenge was declined.`,
      `- "game:start": Game begins! Shows who is white/black and the starting board.`,
      `- "move:made": A move was played. ALWAYS display the board.`,
      `- "game:over": Game ended. You're back in the lobby. Show the final board.`,
      `- "lobby:update": Someone joined/left or a game started/ended.`,
      `- "player:joined" / "player:left": Player roster changes.`,
      `- "player:message": A message from another player. Show it to the user.`,
      ``,
      `MESSAGING:`,
      `- You can send messages to other players using the send_message tool.`,
      `- Use it for commentary, encouragement, or friendly banter.`,
      `- When you receive a player:message event, show the message to your user.`,
    ].join('\n')
  }

  getEventTypes(): string[] {
    return [
      'game:start', 'game:over',
      'move:made', 'board:state',
      'challenge:sent', 'challenge:received', 'challenge:accepted', 'challenge:declined', 'challenge:cancelled',
      'lobby:update', 'lobby:state',
      'player:joined', 'player:left',
      'player:message',
    ]
  }

  getRoleAssignments(players: PlayerInfo[]): Map<string, string> {
    const roles = new Map<string, string>()
    for (const p of players) {
      const gameInstanceId = this.inGameInstances.get(p.token)
      if (gameInstanceId) {
        const instance = this.instances.get(gameInstanceId)
        if (instance) {
          if (instance.whitePlayer.token === p.token) roles.set(p.token, 'white')
          else if (instance.blackPlayer.token === p.token) roles.set(p.token, 'black')
          else roles.set(p.token, 'spectator')
        } else {
          roles.set(p.token, 'lobby')
        }
      } else {
        roles.set(p.token, 'lobby')
      }
    }
    return roles
  }

  // No configurable knobs in beta. Required by GameModule interface.
  getConfig(): Record<string, unknown> {
    return {}
  }

  setConfig(_config: Record<string, unknown>): void {
    // Intentional no-op.
  }

  // --- Lobby actions ---

  private handleChallenge(player: PlayerInfo, data: unknown): ActionResult {
    const { opponent: opponentName, color } = data as { opponent: string; color?: string }

    if (this.inGameInstances.has(player.token)) {
      return { ok: false, error: 'You are already in a game', events: [] }
    }

    if (opponentName.toLowerCase() === player.name.toLowerCase()) {
      return { ok: false, error: 'Cannot challenge yourself', events: [] }
    }

    // Find opponent by name (only lobby players are in playersByToken).
    const opponent = this.findPlayerByName(opponentName)
    if (!opponent) {
      return { ok: false, error: `Player "${opponentName}" not found in the lobby`, events: [] }
    }

    if (this.inGameInstances.has(opponent.token)) {
      return { ok: false, error: `${opponent.name} is already in a game`, events: [] }
    }

    const challenge: Challenge = {
      id: randomUUID(),
      challenger: player,
      opponent,
      challengerColor: (color as 'white' | 'black' | 'random') ?? 'random',
    }
    this.challenges.set(challenge.id, challenge)

    return {
      ok: true,
      events: [
        {
          type: 'challenge:sent',
          data: { challengeId: challenge.id, opponent: opponent.name },
          _targetPlayer: player.token,
        },
        {
          type: 'challenge:received',
          data: { challengeId: challenge.id, challenger: player.name, color: challenge.challengerColor },
          _targetPlayer: opponent.token,
        },
      ],
    }
  }

  private handleAcceptChallenge(player: PlayerInfo, data: unknown): ActionResult {
    const { challengeId } = data as { challengeId: string }
    const challenge = this.challenges.get(challengeId)

    if (!challenge) {
      return { ok: false, error: 'Challenge not found', events: [] }
    }
    if (challenge.opponent.token !== player.token) {
      return { ok: false, error: 'This challenge is not for you', events: [] }
    }

    this.challenges.delete(challengeId)

    // Determine colors
    let whitePlayer: PlayerInfo
    let blackPlayer: PlayerInfo
    if (challenge.challengerColor === 'white') {
      whitePlayer = challenge.challenger
      blackPlayer = challenge.opponent
    } else if (challenge.challengerColor === 'black') {
      whitePlayer = challenge.opponent
      blackPlayer = challenge.challenger
    } else {
      // Random
      if (Math.random() < 0.5) {
        whitePlayer = challenge.challenger
        blackPlayer = challenge.opponent
      } else {
        whitePlayer = challenge.opponent
        blackPlayer = challenge.challenger
      }
    }

    const instance: ChessGameInstance = {
      id: randomUUID(),
      engine: new Chess(),
      whitePlayer,
      blackPlayer,
    }
    this.instances.set(instance.id, instance)

    // Track which game both players are in (for our own routing/checks).
    this.inGameInstances.set(challenge.challenger.token, instance.id)
    this.inGameInstances.set(challenge.opponent.token, instance.id)

    // Remove from the lobby roster — they're in a game now, not the lobby.
    this.playersByToken.delete(challenge.challenger.token)
    this.playersByToken.delete(challenge.opponent.token)

    // Cancel any other pending challenges involving these players.
    const cancelEvents = this.cancelChallengesForPlayer(challenge.challenger.token, instance.id)
      .concat(this.cancelChallengesForPlayer(challenge.opponent.token, instance.id))

    return {
      ok: true,
      events: [
        ...cancelEvents,
        {
          type: 'game:start',
          data: {
            gameInstanceId: instance.id,
            white: whitePlayer.name,
            black: blackPlayer.name,
            board: instance.engine.ascii(),
            fen: instance.engine.fen(),
          },
        },
        // Mark both players as in-game so the liveness sweep leaves them alone
        // and so reconnects know what game to drop the player back into.
        {
          type: 'session:state',
          data: {},
          _sessionState: 'in-game',
          _sessionStateToken: whitePlayer.token,
          _sessionStateGameInstanceId: instance.id,
        },
        {
          type: 'session:state',
          data: {},
          _sessionState: 'in-game',
          _sessionStateToken: blackPlayer.token,
          _sessionStateGameInstanceId: instance.id,
        },
        { type: 'lobby:update', data: this.getLobbyData() },
      ],
    }
  }

  private handleDeclineChallenge(player: PlayerInfo, data: unknown): ActionResult {
    const { challengeId } = data as { challengeId: string }
    const challenge = this.challenges.get(challengeId)

    if (!challenge) {
      return { ok: false, error: 'Challenge not found', events: [] }
    }
    if (challenge.opponent.token !== player.token) {
      return { ok: false, error: 'This challenge is not for you', events: [] }
    }

    this.challenges.delete(challengeId)

    return {
      ok: true,
      events: [
        {
          type: 'challenge:declined',
          data: { challengeId, opponent: player.name },
          _targetPlayer: challenge.challenger.token,
        },
      ],
    }
  }

  private handlePlayBot(player: PlayerInfo): ActionResult {
    if (this.inGameInstances.has(player.token)) {
      return { ok: false, error: 'You are already in a game', events: [] }
    }

    const bot: PlayerInfo = {
      name: CHESS_BOT_NAME,
      token: randomUUID(),
      role: 'bot',
    }
    this.botTokens.add(bot.token)

    // Coin-flip color assignment.
    const humanIsWhite = Math.random() < 0.5
    const whitePlayer = humanIsWhite ? player : bot
    const blackPlayer = humanIsWhite ? bot : player

    const instance: ChessGameInstance = {
      id: randomUUID(),
      engine: new Chess(),
      whitePlayer,
      blackPlayer,
    }
    this.instances.set(instance.id, instance)

    // Track both human and bot for make_move routing. The human's session
    // state is also updated via the session:state event below; the bot has
    // no session at all so this map is its only routing reference.
    this.inGameInstances.set(player.token, instance.id)
    this.inGameInstances.set(bot.token, instance.id)

    // Remove the human from the lobby roster (if they were in it).
    this.playersByToken.delete(player.token)

    // Cancel any pending challenges involving the human.
    const cancelEvents = this.cancelChallengesForPlayer(player.token, instance.id)

    return {
      ok: true,
      events: [
        ...cancelEvents,
        {
          type: 'game:start',
          data: {
            gameInstanceId: instance.id,
            white: whitePlayer.name,
            black: blackPlayer.name,
            board: instance.engine.ascii(),
            fen: instance.engine.fen(),
            isBotGame: true,
          },
        },
        // Mark the human as in-game (the bot has no session).
        {
          type: 'session:state',
          data: {},
          _sessionState: 'in-game',
          _sessionStateToken: player.token,
          _sessionStateGameInstanceId: instance.id,
        },
        { type: 'lobby:update', data: this.getLobbyData() },
      ],
    }
  }

  private handleGetLobby(player: PlayerInfo): ActionResult {
    return {
      ok: true,
      events: [{
        type: 'lobby:state',
        data: {
          ...this.getLobbyData(),
          pendingChallenges: this.getPendingChallengesForPlayer(player.token),
        },
        _targetPlayer: player.token,
      }],
    }
  }

  // --- Game instance actions ---

  private routeToGame(
    player: PlayerInfo,
    handler: (instance: ChessGameInstance) => ActionResult,
  ): ActionResult {
    // Prefer the session's gameInstanceId (the source of truth for humans),
    // fall back to our internal map (which is also where bot tokens live).
    const gameInstanceId = player.gameInstanceId ?? this.inGameInstances.get(player.token)
    if (!gameInstanceId) {
      return { ok: false, error: 'You are not in a game. Use challenge to start one.', events: [] }
    }
    const instance = this.instances.get(gameInstanceId)
    if (!instance) {
      // Self-heal an orphaned in-game session: the session (or our routing map)
      // claims the player is in a game, but the instance is gone. This can
      // happen if a future cleanup (#23) destroys an instance without resetting
      // the session, or after any other invariant break. Rather than strand the
      // player with a dead-end error on every action, reset them to 'connected'
      // (via the same session:state channel endGame uses) and clear our map so
      // subsequent actions report a clean "not in a game". The chess module
      // holds no SessionManager reference by design — see the inGameInstances
      // doc comment — so the corrective transition rides the event channel.
      this.inGameInstances.delete(player.token)
      return {
        ok: false,
        error: 'That game has ended (it is no longer on the server). You are back to connected — start a new game with play_bot, or enter_lobby to find a human opponent.',
        events: [
          {
            type: 'session:state',
            data: {},
            _sessionState: 'connected',
            _sessionStateToken: player.token,
          },
        ],
      }
    }
    return handler(instance)
  }

  private handleMove(instance: ChessGameInstance, player: PlayerInfo, data: unknown): ActionResult {
    const currentTurn = instance.engine.turn()
    const isWhiteTurn = currentTurn === 'w'
    const isPlayersTurn =
      (isWhiteTurn && player.token === instance.whitePlayer.token) ||
      (!isWhiteTurn && player.token === instance.blackPlayer.token)

    if (!isPlayersTurn) {
      const turnColor = isWhiteTurn ? 'white' : 'black'
      return { ok: false, error: `Not your turn — it's ${turnColor}'s turn`, events: [] }
    }

    const { move } = data as { move: string }
    if (!move || typeof move !== 'string') {
      return { ok: false, error: 'Missing move', events: [] }
    }

    let result
    try {
      result = instance.engine.move(move)
    } catch {
      return { ok: false, error: `Illegal move: ${move}`, events: [] }
    }
    if (!result) {
      return { ok: false, error: `Illegal move: ${move}`, events: [] }
    }

    const moveData = {
      gameInstanceId: instance.id,
      move: result.san,
      player: player.name,
      board: instance.engine.ascii(),
      fen: instance.engine.fen(),
      turn: instance.engine.turn() === 'w' ? 'white' : 'black',
      isCheck: instance.engine.isCheck(),
      moveNumber: instance.engine.moveNumber(),
    }

    const events: GameEvent[] = [{
      type: 'move:made',
      data: moveData,
    }]

    // Check for game end
    if (instance.engine.isCheckmate()) {
      const winner = isWhiteTurn ? instance.whitePlayer : instance.blackPlayer
      const loser = isWhiteTurn ? instance.blackPlayer : instance.whitePlayer
      events.push(...this.endGame(instance, 'checkmate', winner.name, loser.name))
    } else if (instance.engine.isDraw()) {
      const reason = instance.engine.isStalemate() ? 'stalemate' : 'draw'
      events.push(...this.endGame(instance, reason))
    }

    // Echo the resulting board state in the action response so the caller
    // sees the move's effect immediately, instead of having to wait for the
    // move:made SSE event. Without this the LLM hallucinates between calling
    // make_move and the event arriving. See issue #15.
    return { ok: true, events, responseData: moveData }
  }

  private handleGetBoard(instance: ChessGameInstance, player: PlayerInfo): ActionResult {
    return {
      ok: true,
      events: [{
        type: 'board:state',
        data: {
          gameInstanceId: instance.id,
          board: instance.engine.ascii(),
          fen: instance.engine.fen(),
          turn: instance.engine.turn() === 'w' ? 'white' : 'black',
          legalMoves: instance.engine.moves(),
          isCheck: instance.engine.isCheck(),
          white: instance.whitePlayer.name,
          black: instance.blackPlayer.name,
          moveNumber: instance.engine.moveNumber(),
        },
        _targetPlayer: player.token,
      }],
    }
  }

  private handleResign(instance: ChessGameInstance, player: PlayerInfo): ActionResult {
    const opponent = instance.whitePlayer.token === player.token
      ? instance.blackPlayer
      : instance.whitePlayer

    return {
      ok: true,
      events: this.endGame(instance, 'resign', opponent.name, player.name),
    }
  }

  // --- Helpers ---

  private endGame(
    instance: ChessGameInstance,
    reason: string,
    winner?: string,
    loser?: string,
  ): GameEvent[] {
    // Snapshot human tokens before we mutate the internal maps below.
    const humanTokens: string[] = []
    for (const side of [instance.whitePlayer, instance.blackPlayer]) {
      if (!this.botTokens.has(side.token)) {
        humanTokens.push(side.token)
      }
    }

    // Clean up routing. Bot tokens are ephemeral (per game instance) and get
    // fully removed. Humans get their in-game tracking removed; their session
    // state transitions to 'connected' via the event below.
    for (const side of [instance.whitePlayer, instance.blackPlayer]) {
      if (this.botTokens.has(side.token)) {
        this.botTokens.delete(side.token)
      }
      this.inGameInstances.delete(side.token)
    }
    this.instances.delete(instance.id)

    const gameOverData: Record<string, unknown> = {
      gameInstanceId: instance.id,
      reason,
      board: instance.engine.ascii(),
    }
    if (winner) gameOverData.winner = winner
    if (loser) gameOverData.loser = loser
    if (!winner && !loser) {
      gameOverData.white = instance.whitePlayer.name
      gameOverData.black = instance.blackPlayer.name
    }

    // Return humans to 'connected' (per docs/player-state.md — they opt back
    // into the lobby explicitly via enter_lobby if they want to).
    const events: GameEvent[] = [{ type: 'game:over', data: gameOverData }]
    for (const token of humanTokens) {
      events.push({
        type: 'session:state',
        data: {},
        _sessionState: 'connected',
        _sessionStateToken: token,
      })
    }
    // The lobby roster is unchanged by game-end (the humans were already out
    // of it once they entered the game). But emit lobby:update anyway so
    // viewers see activeGames update.
    events.push({ type: 'lobby:update', data: this.getLobbyData() })
    return events
  }

  /**
   * Search for a player by name across both the lobby roster (playersByToken)
   * AND active game instances. Used by handleChallenge to give a useful
   * "already in a game" error for in-game players rather than "not found".
   */
  private findPlayerByName(name: string): PlayerInfo | null {
    const normalized = name.trim().toLowerCase()
    for (const player of this.playersByToken.values()) {
      if (player.name.toLowerCase() === normalized) return player
    }
    for (const instance of this.instances.values()) {
      for (const side of [instance.whitePlayer, instance.blackPlayer]) {
        if (side.name.toLowerCase() === normalized) return side
      }
    }
    return null
  }

  private cancelChallengesForPlayer(token: string, excludeChallengeId?: string): GameEvent[] {
    const events: GameEvent[] = []
    for (const [id, challenge] of this.challenges) {
      if (id === excludeChallengeId) continue
      if (challenge.challenger.token === token || challenge.opponent.token === token) {
        this.challenges.delete(id)
        const otherToken = challenge.challenger.token === token
          ? challenge.opponent.token
          : challenge.challenger.token
        events.push({
          type: 'challenge:cancelled',
          data: { challengeId: id, reason: 'Player started a game' },
          _targetPlayer: otherToken,
        })
      }
    }
    return events
  }

  private getLobbyPlayerNames(): string[] {
    // playersByToken IS the lobby roster: populated by onPlayerJoin
    // (called from handleEnterLobby), cleared in onPlayerLeave and when
    // players enter a game. See docs/player-state.md.
    return [...this.playersByToken.values()].map(p => p.name)
  }

  private getActiveGameSummaries(): Array<Record<string, unknown>> {
    return [...this.instances.values()].map(inst => ({
      gameInstanceId: inst.id,
      white: inst.whitePlayer.name,
      black: inst.blackPlayer.name,
      moveNumber: inst.engine.moveNumber(),
      turn: inst.engine.turn() === 'w' ? 'white' : 'black',
    }))
  }

  private getPendingChallengeSummaries(): Array<Record<string, unknown>> {
    return [...this.challenges.values()].map(c => ({
      challengeId: c.id,
      challenger: c.challenger.name,
      opponent: c.opponent.name,
    }))
  }

  private getPendingChallengesForPlayer(token: string): Array<Record<string, unknown>> {
    return [...this.challenges.values()]
      .filter(c => c.challenger.token === token || c.opponent.token === token)
      .map(c => ({
        challengeId: c.id,
        challenger: c.challenger.name,
        opponent: c.opponent.name,
        role: c.challenger.token === token ? 'challenger' : 'recipient',
      }))
  }

  private getLobbyData(): Record<string, unknown> {
    return {
      lobbyPlayers: this.getLobbyPlayerNames(),
      activeGames: this.getActiveGameSummaries(),
    }
  }
}
