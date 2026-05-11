import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Client } from '@notionhq/client'

export type AnalyticsEventType = 'player:join' | 'player:left' | 'game:start' | 'game:over'

export interface AnalyticsRecord {
  id: string
  timestamp: string
  type: AnalyticsEventType
  game: string
  data: Record<string, unknown>
}

export type LogEventInput =
  Omit<AnalyticsRecord, 'id' | 'timestamp'> &
  Partial<Pick<AnalyticsRecord, 'timestamp'>>

export interface EventFilter {
  since?: Date
  type?: AnalyticsEventType
  game?: string
}

export interface EventStore {
  logEvent(input: LogEventInput): Promise<void>
  listEvents(filter?: EventFilter): Promise<AnalyticsRecord[]>
}

export class LocalJsonlEventStore implements EventStore {
  constructor(private filePath: string) {}

  async logEvent(input: LogEventInput): Promise<void> {
    const record: AnalyticsRecord = {
      id: randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      type: input.type,
      game: input.game,
      data: input.data,
    }
    mkdirSync(dirname(this.filePath), { recursive: true })
    appendFileSync(this.filePath, JSON.stringify(record) + '\n')
  }

  async listEvents(filter?: EventFilter): Promise<AnalyticsRecord[]> {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf-8')
    } catch {
      return []
    }

    const records: AnalyticsRecord[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line))
      } catch {
        // Skip malformed lines rather than crashing the read path.
      }
    }

    return records.filter(r => {
      if (filter?.type && r.type !== filter.type) return false
      if (filter?.game && r.game !== filter.game) return false
      if (filter?.since && new Date(r.timestamp) < filter.since) return false
      return true
    })
  }
}

const NOTION_QUEUE_MAX = 100
const NOTION_DRAIN_INTERVAL_MS = 350  // ~3 req/sec, below Notion's published rate limit

export class NotionEventStore implements EventStore {
  private notion: Client
  private queue: AnalyticsRecord[] = []
  private draining = false

  constructor(private databaseId: string, notionToken?: string) {
    const token = notionToken || process.env.NOTION_TOKEN
    if (!token) {
      throw new Error('NOTION_TOKEN environment variable is required for NotionEventStore')
    }
    this.notion = new Client({ auth: token })
  }

  async logEvent(input: LogEventInput): Promise<void> {
    const record: AnalyticsRecord = {
      id: randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      type: input.type,
      game: input.game,
      data: input.data,
    }

    if (this.queue.length >= NOTION_QUEUE_MAX) {
      const dropped = this.queue.shift()
      console.warn(`[analytics] Notion queue full; dropping oldest event: ${dropped?.type}`)
    }
    this.queue.push(record)
    this.startDrain()
  }

  private startDrain(): void {
    if (this.draining) return
    this.draining = true
    const drain = async () => {
      while (this.queue.length > 0) {
        const record = this.queue.shift()!
        try {
          await this.notion.pages.create({
            parent: { database_id: this.databaseId },
            properties: {
              id: {
                title: [{ text: { content: record.id } }],
              },
              timestamp: {
                date: { start: record.timestamp },
              },
              type: {
                rich_text: [{ text: { content: record.type } }],
              },
              game: {
                rich_text: [{ text: { content: record.game } }],
              },
              data: {
                rich_text: [{ text: { content: JSON.stringify(record.data).slice(0, 1900) } }],
              },
            },
          })
        } catch (err) {
          console.error('[analytics] Notion write failed:', err)
        }
        await new Promise(resolve => setTimeout(resolve, NOTION_DRAIN_INTERVAL_MS))
      }
      this.draining = false
    }
    drain()
  }

  async listEvents(filter?: EventFilter): Promise<AnalyticsRecord[]> {
    const result = await this.notion.databases.query({
      database_id: this.databaseId,
    })

    const records: AnalyticsRecord[] = result.results.map(this.pageToRecord)
    return records.filter(r => {
      if (filter?.type && r.type !== filter.type) return false
      if (filter?.game && r.game !== filter.game) return false
      if (filter?.since && new Date(r.timestamp) < filter.since) return false
      return true
    })
  }

  private pageToRecord(page: any): AnalyticsRecord {
    const props = page.properties
    return {
      id: props.id?.title?.[0]?.text?.content ?? '',
      timestamp: props.timestamp?.date?.start ?? '',
      type: (props.type?.rich_text?.[0]?.text?.content ?? 'player:join') as AnalyticsEventType,
      game: props.game?.rich_text?.[0]?.text?.content ?? '',
      data: (() => {
        const raw = props.data?.rich_text?.[0]?.text?.content
        if (!raw) return {}
        try {
          return JSON.parse(raw)
        } catch {
          return {}
        }
      })(),
    }
  }
}
