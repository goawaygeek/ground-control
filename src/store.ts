import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@notionhq/client'

export interface PlayerRecord {
  token: string
  name: string
  createdAt: string
}

export interface PlayerStore {
  getByToken(token: string): PlayerRecord | null | Promise<PlayerRecord | null>
  getByName(name: string): PlayerRecord | null | Promise<PlayerRecord | null>
  create(name: string): PlayerRecord | Promise<PlayerRecord>
  listAll(): PlayerRecord[] | Promise<PlayerRecord[]>
}

export class LocalJsonStore implements PlayerStore {
  private players: PlayerRecord[] = []

  constructor(private filePath: string) {
    this.load()
  }

  getByToken(token: string): PlayerRecord | null {
    return this.players.find(p => p.token === token) ?? null
  }

  getByName(name: string): PlayerRecord | null {
    const normalized = name.trim().toLowerCase()
    return this.players.find(p => p.name.toLowerCase() === normalized) ?? null
  }

  create(name: string): PlayerRecord {
    const normalized = name.trim().toLowerCase()
    if (this.getByName(normalized)) {
      throw new Error(`Player "${normalized}" already exists`)
    }

    const record: PlayerRecord = {
      token: randomUUID(),
      name: normalized,
      createdAt: new Date().toISOString(),
    }

    this.players.push(record)
    this.save()
    return record
  }

  listAll(): PlayerRecord[] {
    return [...this.players]
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      this.players = JSON.parse(raw)
    } catch {
      this.players = []
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.players, null, 2))
  }
}

export class NotionPlayerStore implements PlayerStore {
  private notion: Client

  constructor(private databaseId: string, notionToken?: string) {
    const token = notionToken || process.env.NOTION_TOKEN
    if (!token) {
      throw new Error('NOTION_TOKEN environment variable is required for NotionPlayerStore')
    }
    this.notion = new Client({ auth: token })
  }

  getByToken(token: string): Promise<PlayerRecord | null> {
    return (async () => {
      const result = await this.notion.databases.query({
        database_id: this.databaseId,
        filter: {
          property: 'token',
          rich_text: { equals: token },
        },
      })

      if (result.results.length === 0) return null
      return this.pageToRecord(result.results[0])
    })()
  }

  getByName(name: string): Promise<PlayerRecord | null> {
    return (async () => {
      const normalized = name.trim().toLowerCase()
      const result = await this.notion.databases.query({
        database_id: this.databaseId,
        filter: {
          property: 'name',
          title: { equals: normalized },
        },
      })

      if (result.results.length === 0) return null
      return this.pageToRecord(result.results[0])
    })()
  }

  create(name: string): Promise<PlayerRecord> {
    return (async () => {
      const normalized = name.trim().toLowerCase()
      const existing = await this.getByName(normalized)
      if (existing) {
        throw new Error(`Player "${normalized}" already exists`)
      }

      const token = randomUUID()
      const createdAt = new Date().toISOString()

      await this.notion.pages.create({
        parent: { database_id: this.databaseId },
        properties: {
          name: {
            title: [{ text: { content: normalized } }],
          },
          token: {
            rich_text: [{ text: { content: token } }],
          },
          createdAt: {
            date: { start: createdAt },
          },
        },
      })

      return { token, name: normalized, createdAt }
    })()
  }

  listAll(): Promise<PlayerRecord[]> {
    return (async () => {
      const result = await this.notion.databases.query({
        database_id: this.databaseId,
      })

      return result.results.map(page => this.pageToRecord(page))
    })()
  }

  private pageToRecord(page: any): PlayerRecord {
    const props = page.properties
    const name = props.name?.title?.[0]?.text?.content || ''
    const token = props.token?.rich_text?.[0]?.text?.content || ''
    let createdAt = props.createdAt?.date?.start
    if (!createdAt) {
      createdAt = new Date().toISOString()
    } else if (!createdAt.includes('T')) {
      // If Notion returns just a date (YYYY-MM-DD), add midnight UTC
      createdAt = `${createdAt}T00:00:00.000Z`
    }

    return { token, name, createdAt }
  }
}
