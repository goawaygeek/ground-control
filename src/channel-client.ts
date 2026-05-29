import { EventSource } from 'eventsource'

type FetchFn = typeof globalThis.fetch

type Result = { ok: true; data?: Record<string, unknown> } | { ok: false; error: string }

// How often the client should POST /<game>/ping. Server reaps sessions whose
// lastPingAt is older than 90s, so 30s gives us 60s of slack for one missed ping.
const PING_INTERVAL_MS = 30_000

export class ChannelClient {
  private playerName: string | null = null
  private token: string | null = null
  private sseConnected = false
  private sseError: string | null = null
  private eventSource: EventSource | null = null
  private fetch: FetchFn
  private persistentToken: string | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  /**
   * True once we've observed a successful ping in this process lifetime.
   * Used to distinguish "the server lost my session" (notify the user) from
   * "I just spawned and the server doesn't know about me yet" (silent rejoin
   * — the parent Claude Code may be restarting MCP servers frequently and we
   * don't want to flood the model with notifications).
   */
  private livenessEstablished = false

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
      this.startPinging()
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

  /**
   * Start posting /ping every PING_INTERVAL_MS so the server knows we're alive.
   * Cloud Run holds half-open SSE connections after the client dies, so the
   * server can't tell from socket state alone — this is the reliable signal.
   * Transient network errors are fine (the server has a 90s grace window);
   * 401s mean the server forgot us and pingOnce will recover + notify.
   */
  private startPinging(): void {
    if (this.pingTimer) return
    this.pingTimer = setInterval(() => {
      this.pingOnce().catch(() => { /* swallow — pingOnce handles its own errors */ })
    }, PING_INTERVAL_MS)
    // Don't keep the Node process alive just for the ping timer
    if (typeof (this.pingTimer as any)?.unref === 'function') {
      (this.pingTimer as any).unref()
    }
  }

  /**
   * Fire one ping. Exposed for testability; called repeatedly by startPinging.
   *
   *  - 200 → fine, do nothing
   *  - 401 → server forgot our session (restart, deploy, etc.). Try to rejoin
   *    using the stored token. Emit a system event so Claude can tell the user
   *    something happened — either "session reset, you're back in" or "session
   *    lost, please reconnect".
   *  - Network errors → silent; one missed ping is within the grace window
   */
  async pingOnce(): Promise<void> {
    if (!this.token) return
    let res
    try {
      res = await this.fetch(`${this.serverUrl}/ping`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
      })
    } catch {
      // Transient network blip; server has 90s of slack.
      return
    }

    if (res.status !== 401) {
      // Any non-401 (200 in practice) means we've successfully proved we exist
      // to this server's in-memory session map. Mark it so we know future 401s
      // are a real session loss rather than a fresh-process startup handshake.
      this.livenessEstablished = true
      return
    }

    // 401: silently rejoin via stored token. Whether we notify Claude depends
    // on whether we had previously established liveness in this process — see
    // the field comment above.
    const recovered = await this.rejoinWithToken()
    const shouldNotify = this.livenessEstablished

    if (recovered) {
      this.livenessEstablished = true
      if (shouldNotify) {
        this.onEvent(
          'system:session-reset',
          'Your session was no longer recognised by the server and has been ' +
          're-established automatically. Any game in progress is gone; ' +
          'lobby and analytics state are intact.',
        )
      }
    } else if (shouldNotify) {
      this.onEvent(
        'system:session-lost',
        'Your session was no longer recognised by the server and the automatic ' +
        'reconnect attempt failed. You may need to set_name again to rejoin.',
      )
    }
  }

  /** Stop the ping loop — used by tests and on explicit disconnect. */
  stopPinging(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private async postToServer(endpoint: string, body: unknown, allowRetry = true): Promise<Result> {
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

      // Auto-recovery: a 401 here usually means the server was restarted and
      // its in-memory session map was wiped, even though our token is still
      // valid (it's persisted in Notion). Call /join with the stored token to
      // restore the session, then retry the request once. See issue #12.
      if (res.status === 401 && allowRetry && this.token) {
        const recovered = await this.rejoinWithToken()
        if (recovered) {
          return this.postToServer(endpoint, body, /* allowRetry */ false)
        }
      }

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

  /**
   * Re-call /join with the current stored token. Used to recover from server
   * restarts where the in-memory session was wiped. Does not reset SSE or ping
   * timer — those are already running and the server doesn't track them per-session.
   */
  private async rejoinWithToken(): Promise<boolean> {
    if (!this.token) return false
    try {
      const res = await this.fetch(`${this.serverUrl}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: this.token }),
      })
      return res.ok
    } catch {
      return false
    }
  }
}
