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
}

export interface ActionResult {
  ok: boolean
  error?: string
  events: GameEvent[]
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
