import type { PlayerStore, PlayerRecord } from './store.js'

export interface CachedPlayerStoreOptions {
  /** How many total attempts (1 + retries) for each inner call. Default 3. */
  retries?: number
  /** Base backoff in ms; attempt N waits retryBaseMs * 2^(N-1). Default 200. */
  retryBaseMs?: number
}

/**
 * A caching + retrying decorator around any PlayerStore (in practice,
 * NotionPlayerStore).
 *
 * Why this exists: NotionPlayerStore is on the critical path of every
 * POST /join and makes 1-3 synchronous Notion API calls per join. Under a
 * traffic spike (e.g. a Show HN), Notion's ~3 req/sec limit gets hit, queries
 * return 429, and — with no retry — joins fail and players can't get in.
 *
 * Two mitigations, both safe because PlayerRecords are immutable once created
 * (token, name, createdAt never change):
 *
 *  1. Cache POSITIVE lookups by token and by name, and prime the cache on
 *     create(). A reconnect (the common case under load) becomes a cache hit
 *     with zero Notion calls. NEGATIVE lookups ("name not found") are NEVER
 *     cached — caching them would wrongly reject a name that gets registered
 *     a moment later.
 *  2. Retry inner calls with exponential backoff so transient 429/5xx don't
 *     immediately fail a join.
 */
export class CachedPlayerStore implements PlayerStore {
  private byToken = new Map<string, PlayerRecord>()
  private byName = new Map<string, PlayerRecord>()
  private retries: number
  private retryBaseMs: number

  constructor(private inner: PlayerStore, opts: CachedPlayerStoreOptions = {}) {
    this.retries = opts.retries ?? 3
    this.retryBaseMs = opts.retryBaseMs ?? 200
  }

  async getByToken(token: string): Promise<PlayerRecord | null> {
    const cached = this.byToken.get(token)
    if (cached) return cached

    const record = await this.withRetry(() => this.inner.getByToken(token))
    if (record) this.cache(record)
    return record
  }

  async getByName(name: string): Promise<PlayerRecord | null> {
    const key = name.trim().toLowerCase()
    const cached = this.byName.get(key)
    if (cached) return cached

    const record = await this.withRetry(() => this.inner.getByName(name))
    if (record) this.cache(record)
    return record
  }

  async create(name: string): Promise<PlayerRecord> {
    // Retrying create is safe against duplicates because NotionPlayerStore.create
    // does a getByName check first: if a prior attempt actually landed the page
    // before its response failed, the retry sees the existing record and throws
    // "already exists" rather than creating a second one. We fail safe (surface
    // an error) instead of silently duplicating.
    const record = await this.withRetry(() => this.inner.create(name))
    this.cache(record)
    return record
  }

  async listAll(): Promise<PlayerRecord[]> {
    // Not on the hot path; pass straight through (with retry).
    return this.withRetry(() => this.inner.listAll())
  }

  private cache(record: PlayerRecord): void {
    this.byToken.set(record.token, record)
    this.byName.set(record.name.trim().toLowerCase(), record)
  }

  private async withRetry<T>(fn: () => T | Promise<T>): Promise<T> {
    let lastErr: unknown
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastErr = err
        if (attempt < this.retries) {
          const delay = this.retryBaseMs * 2 ** (attempt - 1)
          if (delay > 0) await new Promise(r => setTimeout(r, delay))
        }
      }
    }
    throw lastErr
  }
}
