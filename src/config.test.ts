import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveConfig } from './config.js'

const originalArgv = process.argv
const originalEnv = { ...process.env }

function setArgv(...args: string[]) {
  process.argv = ['node', 'channel-server.ts', ...args]
}

function clearArgv() {
  process.argv = ['node', 'channel-server.ts']
}

function clearEnvVars() {
  delete process.env.COMEDY_SERVER_URL
  delete process.env.GAME_SERVER_URL
  delete process.env.GAME_ID
}

describe('resolveConfig', () => {
  beforeEach(() => {
    clearArgv()
    clearEnvVars()
  })

  afterEach(() => {
    process.argv = originalArgv
    process.env = { ...originalEnv }
  })

  it('defaults to localhost:8087 with comedy-battle game prefix', () => {
    const config = resolveConfig()
    expect(config.serverUrl).toBe('http://localhost:8087/comedy-battle')
    expect(config.gameId).toBe('comedy-battle')
  })

  it('appends gameId to base server URL', () => {
    setArgv('--game', 'chess')
    const config = resolveConfig()
    expect(config.serverUrl).toBe('http://localhost:8087/chess')
    expect(config.gameId).toBe('chess')
  })

  it('appends gameId to custom server URL', () => {
    setArgv('--server', 'http://example.com:9000', '--game', 'chess')
    const config = resolveConfig()
    expect(config.serverUrl).toBe('http://example.com:9000/chess')
  })

  it('strips trailing slash from base URL before appending gameId', () => {
    setArgv('--server', 'http://example.com:9000/')
    const config = resolveConfig()
    expect(config.serverUrl).toBe('http://example.com:9000/comedy-battle')
  })

  it('respects COMEDY_SERVER_URL env var (backward compat)', () => {
    process.env.COMEDY_SERVER_URL = 'http://env-server:8087'
    const config = resolveConfig()
    expect(config.serverUrl).toBe('http://env-server:8087/comedy-battle')
  })

  it('respects GAME_SERVER_URL env var', () => {
    process.env.GAME_SERVER_URL = 'http://game-server:8087'
    const config = resolveConfig()
    expect(config.serverUrl).toBe('http://game-server:8087/comedy-battle')
  })

  it('GAME_SERVER_URL takes precedence over COMEDY_SERVER_URL', () => {
    process.env.GAME_SERVER_URL = 'http://new'
    process.env.COMEDY_SERVER_URL = 'http://old'
    const config = resolveConfig()
    expect(config.serverUrl).toBe('http://new/comedy-battle')
  })

  it('respects GAME_ID env var', () => {
    process.env.GAME_ID = 'chess'
    const config = resolveConfig()
    expect(config.gameId).toBe('chess')
    expect(config.serverUrl).toBe('http://localhost:8087/chess')
  })

  it('CLI --server takes precedence over env var', () => {
    setArgv('--server', 'http://cli-server')
    process.env.COMEDY_SERVER_URL = 'http://env-server'
    const config = resolveConfig()
    expect(config.serverUrl).toBe('http://cli-server/comedy-battle')
  })

  it('CLI --game takes precedence over GAME_ID env var', () => {
    setArgv('--game', 'chess')
    process.env.GAME_ID = 'trivia'
    const config = resolveConfig()
    expect(config.gameId).toBe('chess')
  })
})
