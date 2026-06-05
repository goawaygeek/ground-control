import { describe, it, expect } from 'vitest'
import { buildOnboardingPreamble } from './onboarding.js'

describe('buildOnboardingPreamble', () => {
  describe('with a saved token (reconnect path)', () => {
    const preamble = buildOnboardingPreamble({ gameId: 'chess', hasToken: true })

    it('instructs an immediate set_name call', () => {
      expect(preamble).toContain('set_name')
    })

    it('makes the tool call the FIRST action, in imperative act-don\'t-narrate terms', () => {
      // The failure mode (esp. on smaller models) is the LLM narrating "I'll
      // call the tool now... let me call it..." and loading the schema without
      // ever invoking it. The preamble must explicitly forbid that.
      const lower = preamble.toLowerCase()
      expect(lower).toContain('first')
      // Forbids narration / explanation / searching before the call.
      expect(lower).toMatch(/do not (explain|narrate|describe|search|announce)/)
    })

    it('tells the model to pass an empty string', () => {
      expect(preamble).toContain('""')
    })

    it('forbids asking the user for a name or confirmation', () => {
      const lower = preamble.toLowerCase()
      expect(lower).toContain('do not ask')
    })

    it('names the channel tag for this game', () => {
      expect(preamble).toContain('source="chess"')
    })

    it('uses the gameId it was given', () => {
      const cb = buildOnboardingPreamble({ gameId: 'comedy-battle', hasToken: true })
      expect(cb).toContain('source="comedy-battle"')
    })
  })

  describe('without a token (fresh registration path)', () => {
    const preamble = buildOnboardingPreamble({ gameId: 'chess', hasToken: false })

    it('tells the model it is NOT yet registered', () => {
      expect(preamble.toLowerCase()).toContain('not')
      expect(preamble).toContain('set_name')
    })

    it('asks for a name (this path SHOULD prompt the user)', () => {
      expect(preamble.toLowerCase()).toContain('name')
    })

    it('does NOT instruct passing an empty string (that is reconnect-only)', () => {
      expect(preamble).not.toContain('""')
    })

    it('names the channel tag for this game', () => {
      expect(preamble).toContain('source="chess"')
    })
  })

  it('returns a non-empty string for both paths', () => {
    expect(buildOnboardingPreamble({ gameId: 'chess', hasToken: true }).length).toBeGreaterThan(0)
    expect(buildOnboardingPreamble({ gameId: 'chess', hasToken: false }).length).toBeGreaterThan(0)
  })
})
