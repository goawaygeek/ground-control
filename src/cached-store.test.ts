import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CachedPlayerStore } from './cached-store.js'
import type { PlayerStore, PlayerRecord } from './store.js'

/**
 * A fake inner store that counts calls and can be made to fail, so we can
 * assert the cache avoids inner calls and the retry logic works — without
 * touching Notion.
 */
class CountingStore implements PlayerStore {
  byToken = new Map<string, PlayerRecord>()
  byName = new Map<string, PlayerRecord>()
  calls = { getByToken: 0, getByName: 0, create: 0, listAll: 0 }
  // If set > 0, the next N calls to any method reject before succeeding.
  failTimes = 0

  private maybeFail() {
    if (this.failTimes > 0) {
      this.failTimes--
      const err: any = new Error('Notion rate limited')
      err.status = 429
      throw err
    }
  }

  async getByToken(token: string): Promise<PlayerRecord | null> {
    this.calls.getByToken++
    this.maybeFail()
    return this.byToken.get(token) ?? null
  }

  async getByName(name: string): Promise<PlayerRecord | null> {
    this.calls.getByName++
    this.maybeFail()
    return this.byName.get(name.trim().toLowerCase()) ?? null
  }

  async create(name: string): Promise<PlayerRecord> {
    this.calls.create++
    this.maybeFail()
    const normalized = name.trim().toLowerCase()
    if (this.byName.has(normalized)) throw new Error(`Player "${normalized}" already exists`)
    const record: PlayerRecord = {
      token: `token-${normalized}`,
      name: normalized,
      createdAt: new Date().toISOString(),
    }
    this.byToken.set(record.token, record)
    this.byName.set(normalized, record)
    return record
  }

  async listAll(): Promise<PlayerRecord[]> {
    this.calls.listAll++
    this.maybeFail()
    return [...this.byToken.values()]
  }
}

describe('CachedPlayerStore', () => {
  let inner: CountingStore
  let store: CachedPlayerStore

  beforeEach(() => {
    inner = new CountingStore()
    // Zero retry delay so tests are fast.
    store = new CachedPlayerStore(inner, { retries: 3, retryBaseMs: 0 })
  })

  describe('caching positive lookups', () => {
    it('caches getByToken so a repeat hit does not call the inner store', async () => {
      const created = await inner.create('alice')
      const first = await store.getByToken(created.token)
      expect(first?.name).toBe('alice')
      expect(inner.calls.getByToken).toBe(1)

      // Second lookup served from cache.
      const second = await store.getByToken(created.token)
      expect(second?.name).toBe('alice')
      expect(inner.calls.getByToken).toBe(1) // no additional inner call
    })

    it('caches getByName so a repeat hit does not call the inner store', async () => {
      await inner.create('bob')
      await store.getByName('bob')
      await store.getByName('bob')
      await store.getByName('BOB') // case-insensitive — same cache key
      expect(inner.calls.getByName).toBe(1)
    })

    it('create populates the cache so subsequent lookups are free', async () => {
      const created = await store.create('carol')
      expect(inner.calls.create).toBe(1)

      await store.getByToken(created.token)
      await store.getByName('carol')
      // Both served from the cache populated by create().
      expect(inner.calls.getByToken).toBe(0)
      expect(inner.calls.getByName).toBe(0)
    })
  })

  describe('NOT caching negative lookups', () => {
    it('does not permanently cache a "name not found" result', async () => {
      // First lookup: miss, hits inner.
      expect(await store.getByName('dave')).toBeNull()
      expect(inner.calls.getByName).toBe(1)

      // Someone registers the name out of band.
      await inner.create('dave')

      // A second lookup must NOT return the stale null — it should hit inner again.
      const found = await store.getByName('dave')
      expect(found).not.toBeNull()
      expect(inner.calls.getByName).toBe(2)
    })

    it('does not permanently cache a "token not found" result', async () => {
      expect(await store.getByToken('token-eve')).toBeNull()
      await inner.create('eve')
      const found = await store.getByToken('token-eve')
      expect(found).not.toBeNull()
    })
  })

  describe('retry on transient failure', () => {
    it('retries getByToken when the inner store throws, then succeeds', async () => {
      const created = await inner.create('frank')
      inner.failTimes = 2 // first two attempts fail, third succeeds
      const found = await store.getByToken(created.token)
      expect(found?.name).toBe('frank')
      expect(inner.calls.getByToken).toBe(3) // 2 failures + 1 success
    })

    it('gives up after exhausting retries and rethrows', async () => {
      const created = await inner.create('grace')
      inner.failTimes = 10 // more than retries
      await expect(store.getByToken(created.token)).rejects.toThrow()
    })

    it('retries create on transient failure', async () => {
      inner.failTimes = 1
      const record = await store.create('heidi')
      expect(record.name).toBe('heidi')
      expect(inner.calls.create).toBe(2)
    })
  })

  describe('transparency / correctness', () => {
    it('delegates listAll to the inner store', async () => {
      await store.create('a')
      await store.create('b')
      const all = await store.listAll()
      expect(all.map(r => r.name).sort()).toEqual(['a', 'b'])
    })

    it('propagates create errors (duplicate name) without caching them', async () => {
      await store.create('dup')
      await expect(store.create('dup')).rejects.toThrow(/already exists/)
    })
  })
})
