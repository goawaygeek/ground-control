import { readFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { resolveConfig } from './config.js'
import { ChannelClient } from './channel-client.js'
import { createGame } from './game/index.js'
import { formatEventContent } from './format-event.js'

// Load .env file if present (no dependency needed)
try {
  const envFile = readFileSync('.env', 'utf-8')
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim()
    if (!process.env[key]) process.env[key] = value
  }
} catch {
  // No .env file — that's fine
}

const { serverUrl, gameId } = resolveConfig()
const persistentToken = process.env.PLAYER_TOKEN || undefined

// Game module — used only for metadata (tools, instructions).
// Actual game state lives on the server.
const game = createGame(gameId)

const client = new ChannelClient(
  serverUrl,
  (type, data) => {
    mcp.notification({
      method: 'notifications/claude/channel' as any,
      params: {
        content: formatEventContent(type, data),
        meta: { type, player: client.getPlayerName() ?? 'unknown' },
      },
    }).catch(() => {
      // If notification fails (e.g. session closing), ignore
    })
  },
  undefined, // fetchFn
  game.getEventTypes(),
  persistentToken,
)

// Universal tools that every game needs
const universalTools = [
  {
    name: 'set_name',
    description: 'Set your player name and join the game. This must be called before any other game action. Ask the user what name they want to play as.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'The player name to join with' },
      },
      required: ['name'],
    },
  },
  {
    name: 'start_round',
    description: 'Start a new game round. Only works when enough players have joined and the game is in the lobby phase.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'get_status',
    description: 'Check connection status and current game state',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to all players in the game room. Use for commentary, encouragement, trash talk, or "good game" messages.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'The message to send' },
      },
      required: ['message'],
    },
  },
]

const onboardingPreamble = persistentToken
  ? [
      `You have a saved player token in your environment. Immediately call set_name with an empty name (pass empty string: "") to reconnect.`,
      `Do NOT ask the user for a name. Do NOT ask for confirmation. Just call the tool right now.`,
      `The server will automatically restore your saved session. If the token is stale, it will tell you to pick a new name.`,
      ``,
      `Once registered, game events arrive as <channel source="${game.gameId}" type="..."> tags.`,
      ``,
    ].join('\n')
  : [
      `FIRST: You are NOT yet registered. Ask the user what name they'd like to play as,`,
      `then call set_name with their answer. If it fails (e.g. name taken), ask them to pick a different name.`,
      ``,
      `Once registered, game events arrive as <channel source="${game.gameId}" type="..."> tags.`,
      ``,
    ].join('\n')

const mcp = new Server(
  { name: game.gameId, version: '0.4.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: onboardingPreamble + game.getInstructions(),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...universalTools, ...game.getTools()],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] })

  // Universal: set_name
  if (req.params.name === 'set_name') {
    const { name } = req.params.arguments as { name?: string }
    const trimmedName = (name ?? '').trim()

    // If we have a persistent token and no name (or empty string), use token for reconnect
    if (persistentToken && !trimmedName) {
      const result = await client.setName('')  // Empty name triggers token-based join
      if (result.ok) {
        const lines = [`Reconnected as "${client.getPlayerName()}"! Waiting for game events...`]
        return textResult(lines.join('\n'))
      }
      // Token reconnect failed — likely the token is stale or no longer in Notion
      const error = result.error ?? ''
      if (error.toLowerCase().includes('invalid token')) {
        const lines = [
          'Your saved player token is no longer valid (it may have expired or been removed from the server).',
          '',
          'Ask the user what name they\'d like to play as, then call set_name again with that name.',
        ]
        return textResult(lines.join('\n'))
      }
      return textResult(`Reconnection failed: ${error}. Please try with a new name.`)
    }

    // Normal name-based join
    if (!trimmedName) {
      return textResult('Please provide a name to join the game.')
    }
    const result = await client.setName(trimmedName)
    if (result.ok) {
      const token = (result as { ok: true; data?: Record<string, unknown> }).data?.token as string | undefined
      const lines = [`Joined the game as "${client.getPlayerName()}"! Waiting for game events...`]
      if (token && !persistentToken) {
        lines.push('')
        lines.push('=== PLAYER TOKEN — SHOW THIS TO THE USER ===')
        lines.push('')
        lines.push(`Your player token: ${token}`)
        lines.push('')
        lines.push('To reconnect as this player next time, add this line to the .env file in the project root:')
        lines.push('')
        lines.push(`PLAYER_TOKEN=${token}`)
        lines.push('')
        lines.push('(The .env file is gitignored so your token stays private.)')
        lines.push('')
        lines.push('YOU MUST display the token AND the .env line above to the user. Do NOT summarize — show the exact line they need to copy.')
      }
      return textResult(lines.join('\n'))
    }
    // Detect "name already registered" errors and provide helpful guidance
    const error = result.error ?? ''
    if (error.toLowerCase().includes('already registered') || error.toLowerCase().includes('already taken')) {
      const lines = [
        `Failed to join: ${error}`,
        '',
        'IMPORTANT — Tell the user the following:',
        `The name "${trimmedName}" is already registered by another player (or a previous session).`,
        '',
        '• If you have played as this name before, you need to add your PLAYER_TOKEN to the .env file in the project root so it can reconnect automatically.',
        '• If you don\'t have your token saved, you\'ll need to pick a different name.',
        '',
        'Ask the user if they have a saved token or want to choose a new name.',
      ]
      return textResult(lines.join('\n'))
    }
    return textResult(`Failed to join: ${error}`)
  }

  // Universal: get_status
  if (req.params.name === 'get_status') {
    const status = client.getStatus()
    try {
      const stateRes = await fetch(`${serverUrl}/state`)
      const state = await stateRes.json()
      return textResult(JSON.stringify({ ...status, gameState: state }, null, 2))
    } catch {
      return textResult(JSON.stringify(status, null, 2))
    }
  }

  // Universal: send_message
  if (req.params.name === 'send_message') {
    const { message } = req.params.arguments as { message: string }
    const result = await client.action('send_message', { message })
    if (!result.ok) return textResult(`Error: ${result.error}`)
    return textResult('Message sent!')
  }

  // Game-specific: start_round is handled specially (its own endpoint)
  if (req.params.name === 'start_round') {
    const result = await client.startRound()
    if (!result.ok) return textResult(`Error: ${result.error}`)
    return textResult(result.data
      ? `Round started!\n${JSON.stringify(result.data, null, 2)}`
      : 'Round started! Game events incoming via channel...'
    )
  }

  // All other tools: dispatch to game via /action using tool name directly
  const gameToolNames = game.getTools().map(t => t.name)
  if (gameToolNames.includes(req.params.name)) {
    const result = await client.action(req.params.name, (req.params.arguments as Record<string, unknown>) ?? {})
    if (!result.ok) return textResult(`Error: ${result.error}`)
    return textResult(result.data
      ? JSON.stringify(result.data, null, 2)
      : `${req.params.name} succeeded!`
    )
  }

  throw new Error(`Unknown tool: ${req.params.name}`)
})

await mcp.connect(new StdioServerTransport())

// Send a welcome notification so Claude knows to ask for the player's name
setTimeout(() => {
  mcp.notification({
    method: 'notifications/claude/channel' as any,
    params: {
      content: JSON.stringify({
        message: `Welcome to ${game.gameId}! You are not registered yet. Please ask the user what name they would like to play as, then call the set_name tool with their answer.`,
      }),
      meta: { type: 'welcome' },
    },
  }).catch(() => {})
}, 500)
