export interface Config {
  serverUrl: string
  gameId: string
}

const DEFAULT_BASE_URL = 'http://localhost:8087'
const DEFAULT_GAME_ID = 'comedy-battle'

export function resolveConfig(): Config {
  const args = process.argv.slice(2)
  let baseUrl: string | undefined
  let gameId: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--server' && args[i + 1]) {
      baseUrl = args[++i]
    }
    if (args[i] === '--game' && args[i + 1]) {
      gameId = args[++i]
    }
  }

  const resolvedBase = (baseUrl ?? process.env.GAME_SERVER_URL ?? process.env.COMEDY_SERVER_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const resolvedGameId = gameId ?? process.env.GAME_ID ?? DEFAULT_GAME_ID

  return {
    serverUrl: `${resolvedBase}/${resolvedGameId}`,
    gameId: resolvedGameId,
  }
}
