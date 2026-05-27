export interface PlayerInfo {
  name: string
  token: string
  role: string
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
   * dispatching the event. Use 'in-game' to exempt the session from the
   * liveness sweep; 'lobby' to put it back. Stripped before broadcast.
   */
  _sessionState?: 'lobby' | 'in-game'
  /** Token for the session whose state should be changed (see _sessionState). */
  _sessionStateToken?: string
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

export type LeaveReason = 'graceful' | 'disconnect' | 'reaped'

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
