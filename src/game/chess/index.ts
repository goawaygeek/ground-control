import { Chess } from 'chess.js'
import { randomUUID } from 'node:crypto'
import type { GameModule, GameEvent, PlayerInfo, ActionResult, McpToolDef, LeaveReason } from '../types.js'

const DEFAULT_TURN_TIME_LIMIT = 120_000 // 2 minutes per move

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

type PlayerState =
  | { status: 'lobby' }
  | { status: 'playing'; gameInstanceId: string }

export const CHESS_BOT_NAME = 'chessbot'

export class ChessGame implements GameModule {
  readonly gameId = 'chess'

  private instances = new Map<string, ChessGameInstance>()
  private challenges = new Map<string, Challenge>()
  private playerStates = new Map<string, PlayerState>() // keyed by token
  private playersByToken = new Map<string, PlayerInfo>()
  private botTokens = new Set<string>()
  private turnTimeLimit = DEFAULT_TURN_TIME_LIMIT

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

  onPlayerJoin(player: PlayerInfo): GameEvent[] {
    this.playerStates.set(player.token, { status: 'lobby' })
    this.playersByToken.set(player.token, player)
    return [
      { type: 'player:joined', data: { name: player.name } },
      { type: 'lobby:update', data: this.getLobbyData() },
    ]
  }

  onPlayerLeave(player: PlayerInfo, reason: LeaveReason): GameEvent[] {
    const events: GameEvent[] = [
      { type: 'player:left', data: { name: player.name, reason } },
    ]

    const state = this.playerStates.get(player.token)

    // If player is in a game, forfeit it
    if (state?.status === 'playing') {
      const instance = this.instances.get(state.gameInstanceId)
      if (instance) {
        const opponent = instance.whitePlayer.token === player.token
          ? instance.blackPlayer
          : instance.whitePlayer
        events.push(...this.endGame(instance, 'forfeit', opponent.name, player.name))
      }
    }

    // Cancel any challenges involving this player
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

    this.playerStates.delete(player.token)
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

  onPhaseTimeout(timerKey?: string): GameEvent[] {
    if (!timerKey) return []
    const instance = this.instances.get(timerKey)
    if (!instance) return []

    const currentTurn = instance.engine.turn()
    const loser = currentTurn === 'w' ? instance.whitePlayer : instance.blackPlayer
    const winner = currentTurn === 'w' ? instance.blackPlayer : instance.whitePlayer

    return this.endGame(instance, 'timeout', winner.name, loser.name)
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
      `LOBBY:`,
      `- When you first join, you're in the lobby. Use get_lobby to see who's around.`,
      `- To play another human, use the challenge tool with their name.`,
      `- If someone challenges you, you'll receive a challenge:received event.`,
      `  Discuss with your human and use accept_challenge or decline_challenge.`,
      `- Once a challenge is accepted, the game starts automatically.`,
      `- If the lobby is empty and your human wants to play immediately, offer them`,
      `  a match against the server bot using the play_bot tool. Mention that they`,
      `  can call play_bot again any time. Do not surface the bot as a lobby player.`,
      ``,
      `DURING A GAME:`,
      `- Use get_board to see the position and legal moves.`,
      `- Analyze the position: what are the threats? What are the opportunities?`,
      `- Suggest 2-3 candidate moves with brief explanations.`,
      `- Let the human pick — then call make_move with their choice.`,
      `- NEVER make a move without the human's agreement.`,
      `- Use resign if your human wants to give up.`,
      ``,
      `AFTER A GAME:`,
      `- You return to the lobby automatically.`,
      `- Challenge someone else or wait for a challenge!`,
      ``,
      `MOVES: Use standard algebraic notation:`,
      `- Pawn moves: e4, d5, exd5 (capture)`,
      `- Piece moves: Nf3 (knight), Bb5 (bishop), Qd1 (queen), Rfe1 (rook)`,
      `- Castling: O-O (kingside), O-O-O (queenside)`,
      `- Promotion: e8=Q`,
      ``,
      `DISPLAYING THE BOARD:`,
      `- When you receive game:start, move:made, or game:over events, ALWAYS display the board to the user.`,
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
      const state = this.playerStates.get(p.token)
      if (state?.status === 'playing') {
        const instance = this.instances.get(state.gameInstanceId)
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

  getConfig(): Record<string, unknown> {
    return { turnTimeLimit: this.turnTimeLimit }
  }

  setConfig(config: Record<string, unknown>): void {
    if (typeof config.turnTimeLimit === 'number' && config.turnTimeLimit > 0) {
      this.turnTimeLimit = config.turnTimeLimit
    }
  }

  // --- Lobby actions ---

  private handleChallenge(player: PlayerInfo, data: unknown): ActionResult {
    const { opponent: opponentName, color } = data as { opponent: string; color?: string }

    const state = this.playerStates.get(player.token)
    if (state?.status === 'playing') {
      return { ok: false, error: 'You are already in a game', events: [] }
    }

    if (opponentName.toLowerCase() === player.name.toLowerCase()) {
      return { ok: false, error: 'Cannot challenge yourself', events: [] }
    }

    // Find opponent by name
    const opponent = this.findPlayerByName(opponentName)
    if (!opponent) {
      return { ok: false, error: `Player "${opponentName}" not found in the lobby`, events: [] }
    }

    const opponentState = this.playerStates.get(opponent.token)
    if (opponentState?.status === 'playing') {
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

    // Move both players to playing state
    this.playerStates.set(challenge.challenger.token, { status: 'playing', gameInstanceId: instance.id })
    this.playerStates.set(challenge.opponent.token, { status: 'playing', gameInstanceId: instance.id })

    // Cancel any other pending challenges involving these players
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
          _nextPhaseTimeout: this.turnTimeLimit,
          _phaseTimerKey: instance.id,
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
    const state = this.playerStates.get(player.token)
    if (state?.status === 'playing') {
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

    // Both human and bot get a 'playing' playerStates entry so make_move
    // routes correctly via routeToGame. The bot stays out of the lobby
    // because it is never registered in playersByToken (see getLobbyPlayerNames).
    this.playerStates.set(player.token, { status: 'playing', gameInstanceId: instance.id })
    this.playerStates.set(bot.token, { status: 'playing', gameInstanceId: instance.id })

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
          _nextPhaseTimeout: this.turnTimeLimit,
          _phaseTimerKey: instance.id,
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
    const state = this.playerStates.get(player.token)
    if (!state || state.status !== 'playing') {
      return { ok: false, error: 'You are not in a game. Use challenge to start one.', events: [] }
    }
    const instance = this.instances.get(state.gameInstanceId)
    if (!instance) {
      return { ok: false, error: 'Game not found', events: [] }
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

    const events: GameEvent[] = [{
      type: 'move:made',
      data: {
        gameInstanceId: instance.id,
        move: result.san,
        player: player.name,
        board: instance.engine.ascii(),
        fen: instance.engine.fen(),
        turn: instance.engine.turn() === 'w' ? 'white' : 'black',
        isCheck: instance.engine.isCheck(),
        moveNumber: instance.engine.moveNumber(),
      },
      _nextPhaseTimeout: this.turnTimeLimit,
      _phaseTimerKey: instance.id,
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

    return { ok: true, events }
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
    // Return human players to lobby; bot tokens are ephemeral (per game instance)
    // and get fully cleaned up rather than left in the lobby state map.
    for (const side of [instance.whitePlayer, instance.blackPlayer]) {
      if (this.botTokens.has(side.token)) {
        this.botTokens.delete(side.token)
        this.playerStates.delete(side.token)
      } else {
        this.playerStates.set(side.token, { status: 'lobby' })
      }
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

    return [
      { type: 'game:over', data: gameOverData },
      { type: 'lobby:update', data: this.getLobbyData() },
    ]
  }

  private findPlayerByName(name: string): PlayerInfo | null {
    const normalized = name.trim().toLowerCase()
    for (const player of this.playersByToken.values()) {
      if (player.name.toLowerCase() === normalized) return player
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
    const names: string[] = []
    for (const [token, state] of this.playerStates) {
      if (state.status === 'lobby') {
        const player = this.playersByToken.get(token)
        if (player) names.push(player.name)
      }
    }
    return names
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
