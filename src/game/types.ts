export interface PlayerInfo {
  name: string
  token: string
  role: string
  /**
   * Session-level state at the time of the action. Populated by the server
   * for /action handlers; optional/undefined in other contexts (tests, the
   * server-side bot which has no session).
   */
  state?: 'connected' | 'lobby' | 'in-game'
  /** Game instance id when state === 'in-game'. */
  gameInstanceId?: string
}

export interface GameEvent {
  type: string
  data: unknown
  /** If set, server should call onPhaseTimeout() after this many ms */
  _nextPhaseTimeout?: number
  /** If set, only send to this player's token (not broadcast) */
  _targetPlayer?: string
  /** Key for this timer — allows multiple concurrent timers (e.g. per game instance) */
  _phaseTimerKey?: string
  /**
   * If set, GameRoom transitions the named session into this state when
   * dispatching the event. See docs/player-state.md for state semantics.
   * Stripped before broadcast.
   */
  _sessionState?: 'connected' | 'lobby' | 'in-game'
  /** Token for the session whose state should be changed (see _sessionState). */
  _sessionStateToken?: string
  /**
   * Set together with _sessionState='in-game' to bind the session to a
   * specific game instance. Used for reconnect-state-preservation: when a
   * player rejoins, the session's gameInstanceId tells the game module which
   * game they were in.
   */
  _sessionStateGameInstanceId?: string
}

export interface ActionResult {
  ok: boolean
  error?: string
  events: GameEvent[]
  /**
   * Optional data to include in the synchronous HTTP response for this action.
   * Used by the caller (e.g. the LLM via MCP) to know the immediate result
   * without waiting for the SSE event to round-trip. See issue #15 — without
   * this, the LLM has been observed to hallucinate intermediate board states.
   */
  responseData?: Record<string, unknown>
}

export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * Why a player left the game module's roster.
 *  - 'graceful': explicit POST /<game>/leave
 *  - 'disconnect': SSE dropped and grace period expired
 *  - 'reaped': liveness sweep cleaned up a stale session
 *  - 'left_lobby': stepped out of the lobby but stayed on the server (connected)
 */
export type LeaveReason = 'graceful' | 'disconnect' | 'reaped' | 'left_lobby'

export interface GameModule {
  readonly gameId: string

  getPhase(): string
  getState(): Record<string, unknown>

  onPlayerJoin(player: PlayerInfo): GameEvent[]
  onPlayerLeave(player: PlayerInfo, reason: LeaveReason): GameEvent[]
  canStartGame(players: PlayerInfo[]): boolean

  startRound(players: PlayerInfo[]): GameEvent[]
  onAction(player: PlayerInfo, action: string, data: unknown): ActionResult
  onPhaseTimeout(timerKey?: string): GameEvent[]

  // Self-describing capabilities
  getTools(): McpToolDef[]
  getInstructions(): string
  getEventTypes(): string[]
  getRoleAssignments(players: PlayerInfo[]): Map<string, string>
  getConfig(): Record<string, unknown>
  setConfig(config: Record<string, unknown>): void
}
