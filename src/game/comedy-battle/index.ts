import type { GameModule, GameEvent, PlayerInfo, ActionResult, McpToolDef, LeaveReason } from '../types.js'

type Phase = 'LOBBY' | 'WRITING' | 'REVEAL' | 'VOTING' | 'RESULTS'

const THEMES = [
  "Cats who think they're the boss",
  'Terrible WiFi',
  'Meetings that should have been emails',
  'Trying to eat healthy',
  'Parallel parking',
  'Software updates at the worst time',
  'Autocorrect disasters',
  'Trying to look busy at work',
  'The gym in January vs February',
  'People who reply-all',
  'Ikea furniture assembly',
  'Airport security theater',
  'Trying to cancel a subscription',
  'Group chats that never end',
  'Smart home devices gone wrong',
]

export interface PhaseDurations {
  writing: number
  reveal: number
  voting: number
  results: number
}

const DEFAULT_DURATIONS: PhaseDurations = {
  writing: 300_000,   // 5 minutes
  reveal:  10_000,    // 10 seconds
  voting:  60_000,    // 60 seconds
  results:  8_000,    // 8 seconds
}

interface Submission {
  playerToken: string
  playerName: string
  joke: string
  submittedAt: number
}

export class ComedyBattle implements GameModule {
  readonly gameId = 'comedy-battle'

  private phase: Phase = 'LOBBY'
  private durations: PhaseDurations
  private currentTheme: string | null = null
  private competitors: [PlayerInfo, PlayerInfo] | null = null
  private submissions: Submission[] = []
  private votes: Map<string, number> = new Map()  // voter token -> joke index (0 or 1)
  private scores: Map<string, number> = new Map() // player token -> cumulative score
  private roundNumber = 0
  private usedThemes: Set<string> = new Set()
  private previousWinnerToken: string | null = null

  constructor(durations?: Partial<PhaseDurations>) {
    this.durations = { ...DEFAULT_DURATIONS, ...durations }
  }

  getPhase(): string {
    return this.phase
  }

  getState(): Record<string, unknown> {
    return {
      phase: this.phase,
      roundNumber: this.roundNumber,
      theme: this.currentTheme,
      competitors: this.competitors?.map(c => c.name) ?? null,
      submissions: this.submissions.length,
      votes: this.votes.size,
      scores: Object.fromEntries(this.scores),
      durations: this.durations,
    }
  }

  onPlayerJoin(player: PlayerInfo): GameEvent[] {
    if (!this.scores.has(player.token)) {
      this.scores.set(player.token, 0)
    }
    return [{
      type: 'player:joined',
      data: { name: player.name, playerCount: this.scores.size },
    }]
  }

  onPlayerLeave(player: PlayerInfo, reason: LeaveReason): GameEvent[] {
    const events: GameEvent[] = [{
      type: 'player:left',
      data: { name: player.name, reason },
    }]

    // If a competitor leaves during WRITING, the other wins by default
    if (this.phase === 'WRITING' && this.competitors) {
      const isCompetitor = this.competitors.some(c => c.token === player.token)
      if (isCompetitor) {
        const winner = this.competitors.find(c => c.token !== player.token)!
        this.scores.set(winner.token, (this.scores.get(winner.token) ?? 0) + 1)
        this.previousWinnerToken = winner.token
        this.phase = 'LOBBY'
        this.resetRoundState()
        events.push({
          type: 'round:result',
          data: {
            winner: winner.name,
            loser: player.name,
            reason: 'forfeit',
            scores: Object.fromEntries(this.scores),
          },
        })
      }
    }

    return events
  }

  canStartGame(players: PlayerInfo[]): boolean {
    return players.length >= 2 && this.phase === 'LOBBY'
  }

  startRound(players: PlayerInfo[]): GameEvent[] {
    if (this.phase !== 'LOBBY') {
      return []
    }
    if (players.length < 2) {
      return []
    }

    this.roundNumber++
    this.resetRoundState()

    // Pick theme (avoid repeats until we exhaust the list)
    const available = THEMES.filter(t => !this.usedThemes.has(t))
    if (available.length === 0) this.usedThemes.clear()
    const pool = available.length > 0 ? available : THEMES
    this.currentTheme = pool[Math.floor(Math.random() * pool.length)]
    this.usedThemes.add(this.currentTheme)

    // Select competitors
    this.competitors = this.selectCompetitors(players)
    this.phase = 'WRITING'

    return [{
      type: 'round:start',
      data: {
        roundNumber: this.roundNumber,
        theme: this.currentTheme,
        competitors: this.competitors.map(c => c.name),
        timeLimitSeconds: this.durations.writing / 1000,
        deadline: new Date(Date.now() + this.durations.writing).toISOString(),
      },
      _nextPhaseTimeout: this.durations.writing,
    }]
  }

  onAction(player: PlayerInfo, action: string, data: unknown): ActionResult {
    switch (action) {
      case 'submit_joke':
        return this.handleSubmit(player, data)
      case 'vote':
        return this.handleVote(player, data)
      default:
        return { ok: false, error: `Unknown action: ${action}`, events: [] }
    }
  }

  onPhaseTimeout(): GameEvent[] {
    switch (this.phase) {
      case 'WRITING':
        // Time's up — if we have at least one submission, reveal. Otherwise cancel round.
        if (this.submissions.length === 0) {
          this.phase = 'LOBBY'
          this.resetRoundState()
          return [{ type: 'round:cancelled', data: { reason: 'No jokes submitted in time' } }]
        }
        // If only one submitted, they win by default
        if (this.submissions.length === 1) {
          const winner = this.submissions[0]
          this.scores.set(winner.playerToken, (this.scores.get(winner.playerToken) ?? 0) + 1)
          this.previousWinnerToken = winner.playerToken
          const loser = this.competitors!.find(c => c.token !== winner.playerToken)!
          this.phase = 'LOBBY'
          this.resetRoundState()
          return [{
            type: 'round:result',
            data: {
              winner: winner.playerName,
              loser: loser.name,
              reason: 'timeout',
              joke: winner.joke,
              scores: Object.fromEntries(this.scores),
            },
          }]
        }
        return this.transitionToReveal()

      case 'REVEAL':
        return this.transitionToVoting()

      case 'VOTING':
        return this.transitionToResults()

      case 'RESULTS':
        this.phase = 'LOBBY'
        return [{ type: 'phase:lobby', data: { message: 'Waiting for next round...' } }]

      default:
        return []
    }
  }

  // --- Self-describing capabilities ---

  getTools(): McpToolDef[] {
    return [
      {
        name: 'submit_joke',
        description: 'Submit your joke to the comedy battle. Only works during WRITING phase when you are a competitor. Only call this when the user has agreed on the joke.',
        inputSchema: {
          type: 'object',
          properties: {
            joke: { type: 'string', description: 'The joke text to submit' },
          },
          required: ['joke'],
        },
      },
      {
        name: 'start_round',
        description: 'Start a new comedy round. Only works when the game is in LOBBY phase with at least 2 players.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'vote',
        description: 'Vote for joke 1 or joke 2 during the VOTING phase.',
        inputSchema: {
          type: 'object',
          properties: {
            jokeNumber: { type: 'number', description: '1 or 2 — which joke to vote for' },
          },
          required: ['jokeNumber'],
        },
      },
    ]
  }

  getInstructions(): string {
    return [
      `You are connected to a Comedy Battle game.`,
      ``,
      `GAME PHASES:`,
      `The game runs in phases: LOBBY → WRITING → REVEAL → VOTING → RESULTS → repeat.`,
      ``,
      `LOBBY: Waiting for players. Use start_round to begin when ready.`,
      ``,
      `WRITING: A theme has been announced! You have limited time to write a joke.`,
      `- COLLABORATE with the user to write the funniest possible joke about the theme`,
      `- Brainstorm ideas together — riff off their suggestions, offer alternatives`,
      `- When you both agree, use submit_joke to submit. Do NOT submit without user agreement.`,
      `- Be enthusiastic and creative!`,
      ``,
      `REVEAL: Both jokes are shown. Read them and react!`,
      ``,
      `VOTING: Time to vote! Use the vote tool to vote for joke 1 or 2.`,
      `- Discuss with the user which joke they think is funnier`,
      `- Vote based on what the user wants`,
      ``,
      `RESULTS: The winner is announced with vote tallies and scores.`,
      ``,
      `KEY EVENTS:`,
      `- "round:start": New round! Contains theme and competitor names.`,
      `- "joke:submitted": Someone submitted (no text shown yet).`,
      `- "joke:accepted": Your joke was accepted.`,
      `- "phase:reveal": Both jokes revealed with full text.`,
      `- "phase:voting": Voting is open.`,
      `- "vote:update": Vote tallies updated.`,
      `- "round:result": Winner announced with scores.`,
      `- "player:joined" / "player:left": Player roster changes.`,
      `- "player:message": A message from another player. Show it to the user.`,
      `- "round:cancelled": Round cancelled (no submissions).`,
      ``,
      `MESSAGING:`,
      `- You can send messages to other players using the send_message tool.`,
      `- Use it for commentary, encouragement, or friendly banter.`,
      `- When you receive a player:message event, show the message to your user.`,
    ].join('\n')
  }

  getEventTypes(): string[] {
    return [
      'round:start', 'round:result', 'round:cancelled',
      'phase:reveal', 'phase:voting', 'phase:lobby',
      'joke:submitted', 'joke:accepted',
      'vote:update',
      'player:joined', 'player:left',
      'competitor:selected',
      'player:message',
    ]
  }

  getRoleAssignments(players: PlayerInfo[]): Map<string, string> {
    const roles = new Map<string, string>()
    for (const p of players) {
      const isCompetitor = this.competitors?.some(c => c.token === p.token) ?? false
      roles.set(p.token, isCompetitor ? 'competitor' : 'audience')
    }
    return roles
  }

  getConfig(): Record<string, unknown> {
    return { ...this.durations }
  }

  setConfig(config: Record<string, unknown>): void {
    const durations: Partial<PhaseDurations> = {}
    for (const key of ['writing', 'reveal', 'voting', 'results'] as const) {
      if (key in config && typeof config[key] === 'number' && (config[key] as number) > 0) {
        durations[key] = config[key] as number
      }
    }
    this.durations = { ...this.durations, ...durations }
  }

  // --- Private helpers ---

  private handleSubmit(player: PlayerInfo, data: unknown): ActionResult {
    if (this.phase !== 'WRITING') {
      return { ok: false, error: 'Not in writing phase', events: [] }
    }

    if (!this.competitors) {
      return { ok: false, error: 'No competitors set', events: [] }
    }

    const isCompetitor = this.competitors.some(c => c.token === player.token)
    if (!isCompetitor) {
      return { ok: false, error: 'You are not a competitor this round', events: [] }
    }

    if (this.submissions.some(s => s.playerToken === player.token)) {
      return { ok: false, error: 'You already submitted a joke this round', events: [] }
    }

    const { joke } = data as { joke: string }
    if (!joke || typeof joke !== 'string') {
      return { ok: false, error: 'Missing joke text', events: [] }
    }

    this.submissions.push({
      playerToken: player.token,
      playerName: player.name,
      joke,
      submittedAt: Date.now(),
    })

    const events: GameEvent[] = [
      {
        type: 'joke:submitted',
        data: { player: player.name, submissionNumber: this.submissions.length },
      },
      {
        type: 'joke:accepted',
        data: { message: 'Your joke has been submitted!' },
        _targetPlayer: player.token,
      },
    ]

    // If both competitors have submitted, move to reveal early
    if (this.submissions.length >= 2) {
      events.push(...this.transitionToReveal())
    }

    return { ok: true, events }
  }

  private handleVote(player: PlayerInfo, data: unknown): ActionResult {
    if (this.phase !== 'VOTING') {
      return { ok: false, error: 'Not in voting phase', events: [] }
    }

    if (this.votes.has(player.token)) {
      return { ok: false, error: 'You already voted this round', events: [] }
    }

    const { jokeNumber } = data as { jokeNumber: number }
    if (jokeNumber !== 1 && jokeNumber !== 2) {
      return { ok: false, error: 'jokeNumber must be 1 or 2', events: [] }
    }

    this.votes.set(player.token, jokeNumber - 1)  // store as 0-indexed

    const tallies = this.getVoteTallies()
    return {
      ok: true,
      events: [{
        type: 'vote:update',
        data: {
          joke1Votes: tallies[0],
          joke2Votes: tallies[1],
          totalVoters: this.votes.size,
        },
      }],
    }
  }

  private selectCompetitors(players: PlayerInfo[]): [PlayerInfo, PlayerInfo] {
    // If there's a previous winner and they're still playing, they stay
    if (this.previousWinnerToken) {
      const winner = players.find(p => p.token === this.previousWinnerToken)
      if (winner) {
        const others = players.filter(p => p.token !== this.previousWinnerToken)
        const challenger = others[Math.floor(Math.random() * others.length)]
        return [winner, challenger]
      }
    }

    // Random two
    const shuffled = [...players].sort(() => Math.random() - 0.5)
    return [shuffled[0], shuffled[1]]
  }

  private transitionToReveal(): GameEvent[] {
    this.phase = 'REVEAL'
    return [{
      type: 'phase:reveal',
      data: {
        theme: this.currentTheme,
        jokes: this.submissions.map((s, i) => ({
          number: i + 1,
          player: s.playerName,
          joke: s.joke,
        })),
      },
      _nextPhaseTimeout: this.durations.reveal,
    }]
  }

  private transitionToVoting(): GameEvent[] {
    this.phase = 'VOTING'
    return [{
      type: 'phase:voting',
      data: {
        theme: this.currentTheme,
        jokes: this.submissions.map((s, i) => ({
          number: i + 1,
          player: s.playerName,
          joke: s.joke,
        })),
        timeLimitSeconds: this.durations.voting / 1000,
      },
      _nextPhaseTimeout: this.durations.voting,
    }]
  }

  private transitionToResults(): GameEvent[] {
    this.phase = 'RESULTS'

    const tallies = this.getVoteTallies()
    let winnerIdx: number

    if (tallies[0] > tallies[1]) {
      winnerIdx = 0
    } else if (tallies[1] > tallies[0]) {
      winnerIdx = 1
    } else {
      // Tie-break: first submission wins
      winnerIdx = 0
    }

    const loserIdx = winnerIdx === 0 ? 1 : 0
    const winner = this.submissions[winnerIdx]
    const loser = this.submissions[loserIdx]

    this.scores.set(winner.playerToken, (this.scores.get(winner.playerToken) ?? 0) + 1)
    this.previousWinnerToken = winner.playerToken

    return [{
      type: 'round:result',
      data: {
        winner: winner.playerName,
        loser: loser.playerName,
        winnerJoke: winner.joke,
        loserJoke: loser.joke,
        votes: { [winner.playerName]: tallies[winnerIdx], [loser.playerName]: tallies[loserIdx] },
        scores: Object.fromEntries(this.scores),
        roundNumber: this.roundNumber,
      },
      _nextPhaseTimeout: this.durations.results,
    }]
  }

  private getVoteTallies(): [number, number] {
    let joke1 = 0
    let joke2 = 0
    for (const idx of this.votes.values()) {
      if (idx === 0) joke1++
      else joke2++
    }
    return [joke1, joke2]
  }

  private resetRoundState(): void {
    this.currentTheme = null
    this.competitors = null
    this.submissions = []
    this.votes.clear()
  }
}
