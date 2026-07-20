/**
 * Formats SSE event data for display in Claude Code channel notifications.
 * Chess board events get human-readable formatting so Claude renders
 * the board instead of showing raw JSON.
 */

import { wrapUntrusted } from './sanitize.js'

const BOARD_EVENTS = new Set(['game:start', 'move:made', 'game:over', 'board:state'])
const CHALLENGE_EVENTS = new Set(['challenge:received', 'challenge:accepted', 'challenge:declined', 'challenge:cancelled'])
const COMEDY_EVENTS = new Set(['round:start', 'phase:reveal', 'phase:voting', 'vote:update', 'round:result', 'round:cancelled'])
const FORMATTED_EVENTS = new Set([
  ...BOARD_EVENTS,
  ...CHALLENGE_EVENTS,
  ...COMEDY_EVENTS,
  'player:message',
  'lobby:update',
  'lobby:state',
])

export function formatEventContent(type: string, data: string): string {
  if (!FORMATTED_EVENTS.has(type)) return data

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(data)
  } catch {
    return data
  }

  if (type === 'player:message') {
    return formatPlayerMessage(parsed)
  }

  if (CHALLENGE_EVENTS.has(type)) {
    return formatChallengeEvent(type, parsed)
  }

  if (type === 'lobby:update' || type === 'lobby:state') {
    return formatLobbyEvent(parsed)
  }

  if (COMEDY_EVENTS.has(type)) {
    return formatComedyEvent(type, parsed)
  }

  // Only format board events if there's a board field
  if (!parsed.board) return data

  switch (type) {
    case 'game:start':
      return formatGameStart(parsed)
    case 'move:made':
      return formatMoveMade(parsed)
    case 'game:over':
      return formatGameOver(parsed)
    case 'board:state':
      return formatBoardState(parsed)
    default:
      return data
  }
}

function formatGameStart(data: Record<string, unknown>): string {
  const lines = [
    `Game started!`,
    `White: ${data.white}  |  Black: ${data.black}`,
    ``,
    data.board as string,
  ]
  return lines.join('\n')
}

function formatMoveMade(data: Record<string, unknown>): string {
  const check = data.isCheck ? ' — Check!' : ''
  const lines = [
    `Move ${data.moveNumber}: ${data.player} played ${data.move}${check}`,
    `Turn: ${data.turn}`,
    ``,
    data.board as string,
  ]
  return lines.join('\n')
}

function formatGameOver(data: Record<string, unknown>): string {
  const lines: string[] = []

  if (data.winner) {
    lines.push(`Game over — ${data.reason}! Winner: ${data.winner}`)
  } else {
    lines.push(`Game over — ${data.reason}!`)
  }

  lines.push('')
  lines.push(data.board as string)

  return lines.join('\n')
}

function formatPlayerMessage(data: Record<string, unknown>): string {
  // The message body is untrusted player text reaching another player's agent —
  // fence it so it can't act as a prompt injection. See sanitize.ts.
  return wrapUntrusted(String(data.message ?? ''), {
    author: String(data.from ?? 'unknown'),
    kind: 'message',
  })
}

function formatChallengeEvent(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case 'challenge:received':
      return `${data.challenger} challenges you to a chess game! (Challenge ID: ${data.challengeId})\nUse accept_challenge or decline_challenge to respond.`
    case 'challenge:accepted':
      return `Challenge accepted! Game starting.`
    case 'challenge:declined':
      return `${data.opponent} declined your challenge.`
    case 'challenge:cancelled':
      return `Challenge cancelled: ${data.reason}`
    default:
      return JSON.stringify(data)
  }
}

function formatLobbyEvent(data: Record<string, unknown>): string {
  const lines: string[] = []
  const lobby = data.lobbyPlayers as string[] | undefined
  const games = data.activeGames as Array<Record<string, unknown>> | undefined

  if (lobby && lobby.length > 0) {
    lines.push(`Players in lobby: ${lobby.join(', ')}`)
  } else {
    lines.push('Lobby is empty')
  }

  if (games && games.length > 0) {
    lines.push(`Active games: ${games.length}`)
    for (const g of games) {
      lines.push(`  ${g.white} vs ${g.black} (move ${g.moveNumber})`)
    }
  }

  if (data.pendingChallenges && Array.isArray(data.pendingChallenges) && data.pendingChallenges.length > 0) {
    lines.push(`Pending challenges:`)
    for (const c of data.pendingChallenges as Array<Record<string, unknown>>) {
      lines.push(`  ${c.challenger} → ${c.opponent} (ID: ${c.challengeId})`)
    }
  }

  return lines.join('\n')
}

function formatBoardState(data: Record<string, unknown>): string {
  const lines = [
    `Position — Move ${data.moveNumber} | Turn: ${data.turn}`,
    `White: ${data.white}  |  Black: ${data.black}`,
    ``,
    data.board as string,
  ]

  if (Array.isArray(data.legalMoves) && data.legalMoves.length > 0) {
    lines.push('')
    lines.push(`Legal moves: ${data.legalMoves.join(', ')}`)
  }

  if (data.isCheck) {
    lines.push('Check!')
  }

  return lines.join('\n')
}

// ─── Comedy Battle ────────────────────────────────────────────────────────

type Joke = { number: number; player: string; joke: string }

function formatComedyEvent(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case 'round:start':
      return formatRoundStart(data)
    case 'phase:reveal':
      return formatPhaseReveal(data)
    case 'phase:voting':
      return formatPhaseVoting(data)
    case 'vote:update':
      return formatVoteUpdate(data)
    case 'round:result':
      return formatRoundResult(data)
    case 'round:cancelled':
      return `Round cancelled: ${data.reason ?? 'no reason given'}`
    default:
      return JSON.stringify(data)
  }
}

function formatRoundStart(data: Record<string, unknown>): string {
  const competitors = (data.competitors as string[] | undefined) ?? []
  const lines = [
    `Round ${data.roundNumber} — theme: "${data.theme}"`,
    `Competitors: ${competitors.join(' vs. ')}`,
    `You have ${data.timeLimitSeconds}s to write a joke.`,
  ]
  return lines.join('\n')
}

function formatPhaseReveal(data: Record<string, unknown>): string {
  const jokes = (data.jokes as Joke[] | undefined) ?? []
  const lines = [`Reveal — theme: "${data.theme}"`, '']
  for (const j of jokes) {
    lines.push(`Joke ${j.number}:`)
    lines.push(wrapUntrusted(String(j.joke ?? ''), { author: String(j.player ?? 'unknown'), kind: 'joke' }))
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

function formatPhaseVoting(data: Record<string, unknown>): string {
  const jokes = (data.jokes as Joke[] | undefined) ?? []
  const lines = [
    `Voting open — theme: "${data.theme}"`,
    `${data.timeLimitSeconds}s to vote.`,
    '',
  ]
  for (const j of jokes) {
    lines.push(`Joke ${j.number}:`)
    lines.push(wrapUntrusted(String(j.joke ?? ''), { author: String(j.player ?? 'unknown'), kind: 'joke' }))
    lines.push('')
  }
  lines.push('Use the vote tool with jokeNumber 1 or 2.')
  return lines.join('\n')
}

function formatVoteUpdate(data: Record<string, unknown>): string {
  return `Votes — Joke 1: ${data.joke1Votes}, Joke 2: ${data.joke2Votes} (${data.totalVoters} total)`
}

function formatRoundResult(data: Record<string, unknown>): string {
  const votes = (data.votes ?? {}) as Record<string, number>
  const scores = (data.scores ?? {}) as Record<string, number>
  const lines = [
    `Round ${data.roundNumber} result: ${data.winner} wins!`,
    '',
    `Winning joke:`,
    wrapUntrusted(String(data.winnerJoke ?? ''), { author: String(data.winner ?? 'unknown'), kind: 'joke' }),
    '',
    `Losing joke:`,
    wrapUntrusted(String(data.loserJoke ?? ''), { author: String(data.loser ?? 'unknown'), kind: 'joke' }),
    '',
    `Votes — ${data.winner}: ${votes[data.winner as string] ?? 0}, ${data.loser}: ${votes[data.loser as string] ?? 0}`,
  ]
  const scoreEntries = Object.entries(scores)
  if (scoreEntries.length > 0) {
    lines.push('')
    lines.push('Scores:')
    for (const [token, score] of scoreEntries) {
      // tokens are UUIDs — show short prefix only
      lines.push(`  ${token.slice(0, 8)}: ${score}`)
    }
  }
  return lines.join('\n')
}
