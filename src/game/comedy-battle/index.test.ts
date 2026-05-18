import { describe, it, expect, beforeEach } from 'vitest'
import { ComedyBattle } from './index.js'
import type { PlayerInfo } from '../types.js'

function makePlayer(name: string, token?: string): PlayerInfo {
  return { name, token: token ?? `token-${name}`, role: 'audience' }
}

describe('ComedyBattle', () => {
  let game: ComedyBattle

  beforeEach(() => {
    game = new ComedyBattle()
  })

  describe('gameId', () => {
    it('has gameId "comedy-battle"', () => {
      expect(game.gameId).toBe('comedy-battle')
    })
  })

  describe('initial state', () => {
    it('starts in LOBBY phase', () => {
      expect(game.getPhase()).toBe('LOBBY')
    })

    it('getState returns phase and round info', () => {
      const state = game.getState()
      expect(state.phase).toBe('LOBBY')
      expect(state.roundNumber).toBe(0)
    })
  })

  describe('onAction — submit', () => {
    let alice: PlayerInfo
    let bob: PlayerInfo

    beforeEach(() => {
      alice = makePlayer('alice')
      bob = makePlayer('bob')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)
      game.startRound([alice, bob])
    })

    it('accepts a joke during WRITING phase from a competitor', () => {
      const state = game.getState()
      const competitors = state.competitors as string[]
      const competitor = competitors.includes('alice') ? alice : bob

      const result = game.onAction(competitor, 'submit_joke', { joke: 'Why did the chicken...' })
      expect(result.ok).toBe(true)
      expect(result.events.length).toBeGreaterThan(0)
    })

    it('rejects submit in wrong phase', () => {
      // Already in WRITING from beforeEach, force back to LOBBY
      const freshGame = new ComedyBattle()
      const result = freshGame.onAction(alice, 'submit_joke', { joke: 'test' })
      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('rejects submit from non-competitor', () => {
      const spectator = makePlayer('charlie', 'token-charlie')
      game.onPlayerJoin(spectator)
      const result = game.onAction(spectator, 'submit_joke', { joke: 'test' })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('not a competitor')
    })
  })

  describe('onAction — vote', () => {
    let alice: PlayerInfo
    let bob: PlayerInfo

    beforeEach(() => {
      alice = makePlayer('alice')
      bob = makePlayer('bob')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)
      game.startRound([alice, bob])

      // Both submit so we can get to voting
      const state = game.getState()
      const competitors = state.competitors as string[]
      const [comp1, comp2] = competitors.includes('alice')
        ? [alice, bob]
        : [bob, alice]
      game.onAction(comp1, 'submit_joke', { joke: 'Joke A' })
      game.onAction(comp2, 'submit_joke', { joke: 'Joke B' })
      // Now in REVEAL phase, advance to VOTING
      game.onPhaseTimeout() // REVEAL -> VOTING
    })

    it('accepts a vote during VOTING phase', () => {
      const result = game.onAction(alice, 'vote', { jokeNumber: 1 })
      expect(result.ok).toBe(true)
      expect(result.events.some(e => e.type === 'vote:update')).toBe(true)
    })

    it('rejects vote in wrong phase', () => {
      const freshGame = new ComedyBattle()
      const result = freshGame.onAction(alice, 'vote', { jokeNumber: 1 })
      expect(result.ok).toBe(false)
    })

    it('rejects invalid jokeNumber', () => {
      const result = game.onAction(alice, 'vote', { jokeNumber: 3 })
      expect(result.ok).toBe(false)
    })

    it('rejects duplicate vote', () => {
      game.onAction(alice, 'vote', { jokeNumber: 1 })
      const result = game.onAction(alice, 'vote', { jokeNumber: 2 })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('already voted')
    })
  })

  describe('onAction — unknown action', () => {
    it('returns error for unknown action', () => {
      const result = game.onAction(makePlayer('alice'), 'fly_to_moon', {})
      expect(result.ok).toBe(false)
      expect(result.error).toContain('Unknown action')
    })
  })

  describe('getTools', () => {
    it('returns tool definitions array', () => {
      const tools = game.getTools()
      expect(Array.isArray(tools)).toBe(true)
      expect(tools.length).toBeGreaterThan(0)
    })

    it('includes submit_joke tool', () => {
      const tools = game.getTools()
      expect(tools.some(t => t.name === 'submit_joke')).toBe(true)
    })

    it('includes start_round tool', () => {
      const tools = game.getTools()
      expect(tools.some(t => t.name === 'start_round')).toBe(true)
    })

    it('includes vote tool', () => {
      const tools = game.getTools()
      expect(tools.some(t => t.name === 'vote')).toBe(true)
    })

    it('each tool has name, description, and inputSchema', () => {
      for (const tool of game.getTools()) {
        expect(tool.name).toBeTruthy()
        expect(tool.description).toBeTruthy()
        expect(tool.inputSchema).toBeDefined()
      }
    })
  })

  describe('getInstructions', () => {
    it('returns a non-empty string', () => {
      const instructions = game.getInstructions()
      expect(typeof instructions).toBe('string')
      expect(instructions.length).toBeGreaterThan(0)
    })

    it('mentions game phases', () => {
      const instructions = game.getInstructions()
      expect(instructions).toContain('WRITING')
      expect(instructions).toContain('VOTING')
    })
  })

  describe('getRoleAssignments', () => {
    it('assigns competitor and audience roles after startRound', () => {
      const alice = makePlayer('alice')
      const bob = makePlayer('bob')
      const charlie = makePlayer('charlie')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)
      game.onPlayerJoin(charlie)

      game.startRound([alice, bob, charlie])

      const roles = game.getRoleAssignments([alice, bob, charlie])
      const roleValues = [...roles.values()]

      expect(roleValues.filter(r => r === 'competitor')).toHaveLength(2)
      expect(roleValues.filter(r => r === 'audience')).toHaveLength(1)
    })

    it('returns empty map when no round active', () => {
      const alice = makePlayer('alice')
      const roles = game.getRoleAssignments([alice])
      // In LOBBY with no competitors, everyone is audience
      expect(roles.get(alice.token)).toBe('audience')
    })
  })

  describe('getConfig / setConfig', () => {
    it('returns durations in config', () => {
      const config = game.getConfig()
      expect(config.writing).toBeDefined()
      expect(config.reveal).toBeDefined()
      expect(config.voting).toBeDefined()
      expect(config.results).toBeDefined()
    })

    it('setConfig updates durations', () => {
      game.setConfig({ writing: 60000 })
      const config = game.getConfig()
      expect(config.writing).toBe(60000)
    })

    it('setConfig preserves other durations', () => {
      const before = game.getConfig()
      game.setConfig({ writing: 60000 })
      const after = game.getConfig()
      expect(after.voting).toBe(before.voting)
    })
  })

  describe('session state events', () => {
    it('startRound emits session:state in-game for every player in the room', () => {
      const alice = makePlayer('alice')
      const bob = makePlayer('bob')
      const charlie = makePlayer('charlie')  // audience
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)
      game.onPlayerJoin(charlie)

      const events = game.startRound([alice, bob, charlie])
      const stateEvents = events.filter(e => e.type === 'session:state')
      expect(stateEvents).toHaveLength(3)
      const tokens = stateEvents.map(e => (e as any)._sessionStateToken).sort()
      expect(tokens).toEqual([alice.token, bob.token, charlie.token].sort())
      for (const ev of stateEvents) {
        expect((ev as any)._sessionState).toBe('in-game')
      }
    })

    it('RESULTS -> LOBBY transition emits session:state lobby for every roundies player', () => {
      const alice = makePlayer('alice')
      const bob = makePlayer('bob')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)
      game.startRound([alice, bob])

      const competitors = (game.getState() as any).competitors as string[]
      const [comp1, comp2] = competitors[0] === 'alice' ? [alice, bob] : [bob, alice]

      game.onAction(comp1, 'submit_joke', { joke: 'A' })
      game.onAction(comp2, 'submit_joke', { joke: 'B' })
      game.onPhaseTimeout() // REVEAL -> VOTING
      game.onPhaseTimeout() // VOTING -> RESULTS

      const endEvents = game.onPhaseTimeout() // RESULTS -> LOBBY
      const stateEvents = endEvents.filter(e => e.type === 'session:state')
      expect(stateEvents).toHaveLength(2)
      for (const ev of stateEvents) {
        expect((ev as any)._sessionState).toBe('lobby')
      }
    })

    it('forfeit (competitor leaves during WRITING) emits session:state lobby for everyone', () => {
      const alice = makePlayer('alice')
      const bob = makePlayer('bob')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)
      game.startRound([alice, bob])

      const competitors = (game.getState() as any).competitors as string[]
      const leaver = competitors[0] === 'alice' ? alice : bob

      const events = game.onPlayerLeave(leaver, 'disconnect')
      const stateEvents = events.filter(e => e.type === 'session:state')
      expect(stateEvents).toHaveLength(2)
      for (const ev of stateEvents) {
        expect((ev as any)._sessionState).toBe('lobby')
      }
    })

    it('writing timeout with zero submissions emits session:state lobby', () => {
      const alice = makePlayer('alice')
      const bob = makePlayer('bob')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)
      game.startRound([alice, bob])

      const events = game.onPhaseTimeout() // WRITING with 0 submissions
      expect(events.some(e => e.type === 'round:cancelled')).toBe(true)
      const stateEvents = events.filter(e => e.type === 'session:state')
      expect(stateEvents).toHaveLength(2)
      for (const ev of stateEvents) {
        expect((ev as any)._sessionState).toBe('lobby')
      }
    })
  })

  describe('full phase cycle', () => {
    it('cycles LOBBY -> WRITING -> REVEAL -> VOTING -> RESULTS -> LOBBY', () => {
      const alice = makePlayer('alice')
      const bob = makePlayer('bob')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)

      expect(game.getPhase()).toBe('LOBBY')

      game.startRound([alice, bob])
      expect(game.getPhase()).toBe('WRITING')

      // Get actual competitors
      const state = game.getState()
      const competitors = state.competitors as string[]
      const [comp1, comp2] = competitors[0] === 'alice'
        ? [alice, bob]
        : [bob, alice]

      game.onAction(comp1, 'submit_joke', { joke: 'Joke 1' })
      game.onAction(comp2, 'submit_joke', { joke: 'Joke 2' })
      expect(game.getPhase()).toBe('REVEAL')

      game.onPhaseTimeout() // REVEAL -> VOTING
      expect(game.getPhase()).toBe('VOTING')

      game.onPhaseTimeout() // VOTING -> RESULTS
      expect(game.getPhase()).toBe('RESULTS')

      game.onPhaseTimeout() // RESULTS -> LOBBY
      expect(game.getPhase()).toBe('LOBBY')
    })
  })

  describe('player leave during WRITING', () => {
    it('awards forfeit win to remaining competitor', () => {
      const alice = makePlayer('alice')
      const bob = makePlayer('bob')
      game.onPlayerJoin(alice)
      game.onPlayerJoin(bob)
      game.startRound([alice, bob])

      const state = game.getState()
      const competitors = state.competitors as string[]
      const leaver = competitors[0] === 'alice' ? alice : bob
      const stayer = competitors[0] === 'alice' ? bob : alice

      const events = game.onPlayerLeave(leaver, 'disconnect')
      expect(events.some(e => e.type === 'round:result')).toBe(true)
      const result = events.find(e => e.type === 'round:result')!
      expect((result.data as any).winner).toBe(stayer.name)
      expect((result.data as any).reason).toBe('forfeit')
      expect(game.getPhase()).toBe('LOBBY')
    })
  })
})
