import { EventSource } from 'eventsource'

type FetchFn = typeof globalThis.fetch

type Result = { ok: true; data?: Record<string, unknown> } | { ok: false; error: string }

export class ChannelClient {
  private playerName: string | null = null
  private token: string | null = null
  private sseConnected = false
  private sseError: string | null = null
  private eventSource: EventSource | null = null
  private fetch: FetchFn
  private persistentToken: string | null = null

  constructor(
    private serverUrl: string,
    private onEvent: (type: string, data: string) => void,
    fetchFn?: FetchFn,
    private eventTypes?: string[],
    persistentToken?: string,
  ) {
    this.fetch = fetchFn ?? globalThis.fetch
    this.persistentToken = persistentToken ?? null
  }

  isConfigured(): boolean {
    return this.playerName !== null && this.token !== null
  }

  getPlayerName(): string | null {
    return this.playerName
  }

  async setName(name: string): Promise<Result> {
    const trimmed = name.trim()

    // Empty name is only valid if we have a persistent token to use for reconnect
    if (!trimmed && !this.persistentToken) {
      return { ok: false, error: 'Player name cannot be empty' }
    }

    if (this.isConfigured()) {
      return { ok: false, error: `Already joined as "${this.playerName}"` }
    }

    try {
      // If we have a persistent token, use it for reconnect (ignore provided name)
      const body = this.persistentToken
        ? { token: this.persistentToken }
        : { name: trimmed }

      const res = await this.fetch(`${this.serverUrl}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const data = await res.json() as { token?: string; name?: string; error?: string }

      if (!res.ok) {
        // If token-based join fails, fall back to name-based
        if (this.persistentToken) {
          this.persistentToken = null
          return this.setName(name)
        }
        return { ok: false, error: data.error ?? `Join failed: ${res.status}` }
      }

      this.playerName = data.name ?? trimmed
      this.token = data.token!
      this.connectSSE()
      return { ok: true, data: { token: this.token, name: this.playerName } as any }
    } catch (err) {
      return { ok: false, error: `Failed to connect: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  async action(actionType: string, data: Record<string, unknown> = {}): Promise<Result> {
    return this.postToServer('/action', { action: actionType, ...data })
  }

  async startRound(): Promise<Result> {
    return this.postToServer('/start-round', {})
  }

  getStatus(): Record<string, unknown> {
    if (!this.isConfigured()) {
      return {
        configured: false,
        serverUrl: this.serverUrl,
        message: 'Not yet registered. Call set_name to join.',
      }
    }
    return {
      configured: true,
      player: this.playerName,
      serverUrl: this.serverUrl,
      sseConnected: this.sseConnected,
      sseError: this.sseError,
    }
  }

  connectSSE(): void {
    if (!this.token) return

    const es = new EventSource(`${this.serverUrl}/events?token=${encodeURIComponent(this.token)}`)

    es.onopen = () => {
      this.sseConnected = true
      this.sseError = null
    }

    es.onerror = () => {
      this.sseConnected = false
      this.sseError = 'SSE connection error'
    }

    const ignoredEvents = new Set(['heartbeat', 'connected'])

    if (this.eventTypes && this.eventTypes.length > 0) {
      // Listen for specific game event types
      for (const eventType of this.eventTypes) {
        es.addEventListener(eventType, (e: MessageEvent) => {
          if (!ignoredEvents.has(eventType)) {
            this.onEvent(eventType, e.data)
          }
        })
      }
    }

    // Always listen for unnamed messages as a fallback
    es.onmessage = (e: MessageEvent) => {
      this.onEvent('message', e.data)
    }

    this.eventSource = es
  }

  private async postToServer(endpoint: string, body: unknown): Promise<Result> {
    if (!this.isConfigured()) {
      return { ok: false, error: 'Not registered yet. Use set_name first.' }
    }

    try {
      const res = await this.fetch(`${this.serverUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text()
        return { ok: false, error: text }
      }
      try {
        const data = await res.json() as Record<string, unknown>
        return { ok: true, data }
      } catch {
        return { ok: true }
      }
    } catch (err) {
      return { ok: false, error: `Request failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}
