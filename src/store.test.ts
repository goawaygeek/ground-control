import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LocalJsonStore } from './store.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('LocalJsonStore', () => {
  let dir: string
  let store: LocalJsonStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gsl-test-'))
    store = new LocalJsonStore(join(dir, 'players.json'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('create', () => {
    it('creates a player with a UUID token', () => {
      const record = store.create('alice')
      expect(record.name).toBe('alice')
      expect(record.token).toMatch(/^[0-9a-f-]{36}$/)
      expect(record.createdAt).toBeDefined()
    })

    it('rejects duplicate names', () => {
      store.create('alice')
      expect(() => store.create('alice')).toThrow(/already exists/)
    })

    it('names are case-insensitive', () => {
      store.create('Alice')
      expect(() => store.create('alice')).toThrow(/already exists/)
    })
  })

  describe('getByToken', () => {
    it('returns the player for a valid token', () => {
      const created = store.create('bob')
      const found = store.getByToken(created.token)
      expect(found).not.toBeNull()
      expect(found!.name).toBe('bob')
      expect(found!.token).toBe(created.token)
    })

    it('returns null for unknown token', () => {
      expect(store.getByToken('nonexistent')).toBeNull()
    })
  })

  describe('getByName', () => {
    it('returns the player for an existing name', () => {
      const created = store.create('carol')
      const found = store.getByName('carol')
      expect(found).not.toBeNull()
      expect(found!.token).toBe(created.token)
    })

    it('is case-insensitive', () => {
      store.create('Dave')
      expect(store.getByName('dave')).not.toBeNull()
      expect(store.getByName('DAVE')).not.toBeNull()
    })

    it('returns null for unknown name', () => {
      expect(store.getByName('nobody')).toBeNull()
    })
  })

  describe('listAll', () => {
    it('returns empty array initially', () => {
      expect(store.listAll()).toEqual([])
    })

    it('returns all created players', () => {
      store.create('alice')
      store.create('bob')
      store.create('carol')
      const all = store.listAll()
      expect(all).toHaveLength(3)
      expect(all.map(p => p.name).sort()).toEqual(['alice', 'bob', 'carol'])
    })
  })

  describe('persistence', () => {
    it('survives re-instantiation from the same file', () => {
      const filePath = join(dir, 'players.json')
      const store1 = new LocalJsonStore(filePath)
      const created = store1.create('eve')

      // Create a new instance pointing to the same file
      const store2 = new LocalJsonStore(filePath)
      const found = store2.getByToken(created.token)
      expect(found).not.toBeNull()
      expect(found!.name).toBe('eve')
    })

    it('persists multiple players across restarts', () => {
      const filePath = join(dir, 'players.json')
      const store1 = new LocalJsonStore(filePath)
      store1.create('alice')
      store1.create('bob')

      const store2 = new LocalJsonStore(filePath)
      expect(store2.listAll()).toHaveLength(2)
    })
  })

  describe('edge cases', () => {
    it('works when file does not exist yet', () => {
      const freshStore = new LocalJsonStore(join(dir, 'new-file.json'))
      expect(freshStore.listAll()).toEqual([])
      freshStore.create('first')
      expect(freshStore.listAll()).toHaveLength(1)
    })
  })
})
