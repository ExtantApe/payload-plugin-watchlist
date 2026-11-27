import type { CollectionConfig, Config, PayloadRequest } from 'payload'
import { beforeEach, describe, expect, it } from 'vitest'

import { watchlist } from '../src/index.js'
import { getCreator, getVideo, isError, listCreators, listVideos } from '../src/server/index.js'

// A paginated find makes Payload's Mongo adapter send the find and its count at once on the request's session. When
// that's the first query in a transaction, the two race to start it and one fails with NoSuchTransaction. So a find
// that carries a `req`, and so can run inside that request's transaction, passes `pagination: false` unless it pages
// for a person (a `page` argument, totals returned).
//
// No database here: a made-up Payload whose `find` writes down what it was asked, so the test reads the arguments
// themselves. The race needs a real replica set and luck, and isn't reproduced.

type Args = Record<string, unknown> & { collection: string; req?: { transactionID?: unknown } }
const TRANSACTION = 'made-up-transaction'
const VIDEO_ID = 'madeupvid01'

const config = watchlist({ scope: { field: 'tenant', ofRequest: () => 'A', sitesFor: () => [], isAdmin: () => true }, enabled: () => false })({ collections: [] } as unknown as Config) as Config
const creators = config.collections!.find((c) => c.slug === 'creators') as CollectionConfig

const rows: Record<string, Record<string, unknown>[]> = {
  creators: [
    { id: 'c1', name: 'Made-up Alpha', slug: 'made-up-alpha', tenant: 'A', _order: 'a1', videosDefault: 'picked' },
    { id: 'c2', name: 'Made-up Zulu', slug: 'made-up-zulu', tenant: 'A', _order: 'a2', videosDefault: 'picked' },
  ],
  videos: [{ id: 'v1', youtubeId: VIDEO_ID, title: 'Made-up video', creator: { id: 'c1', name: 'Made-up Alpha', slug: 'made-up-alpha' }, channelId: null, curation: 'picked' }],
}

let finds: Args[]
let updates: Args[]
let req: PayloadRequest
beforeEach(() => {
  finds = []
  updates = []
  const payload = {
    config,
    logger: { error: () => undefined },
    find: async (args: Args) => {
      finds.push(args)
      const docs = rows[args.collection] ?? []
      return { docs, page: 1, totalPages: 1, totalDocs: docs.length }
    },
    update: async (args: Args) => {
      updates.push(args)
      return { docs: [], errors: [] }
    },
  }
  req = { payload, user: { id: 'made-up-person' }, context: {}, headers: new Headers(), transactionID: TRANSACTION } as unknown as PayloadRequest
})

/** The finds that can run inside the request's transaction, split into those that page for a person and the rest. */
const inTransaction = () => {
  const withReq = finds.filter((f) => f.req)
  for (const f of withReq) expect(f.req!.transactionID, `the ${f.collection} find carries the request's transaction`).toBe(TRANSACTION)
  return { paged: withReq.filter((f) => 'page' in f), rest: withReq.filter((f) => !('page' in f)) }
}
const expectUnpaginated = (list: Args[]) => {
  for (const f of list) expect(f.pagination, `the ${f.collection} find must pass pagination: false`).toBe(false)
}

describe('finds that can run inside a request’s transaction don’t paginate', () => {
  it('a creator’s page: the lookup by slug sends no count; only the list that pages for the visitor does', async () => {
    const r = await getCreator(req, { slug: 'made-up-alpha' })
    expect(isError(r)).toBe(false)
    expect(r).toMatchObject({ creator: { name: 'Made-up Alpha' }, total: 1 })
    const { paged, rest } = inTransaction()
    expect(finds).toHaveLength(2)
    expect(rest.map((f) => f.collection)).toEqual(['creators'])
    expectUnpaginated(rest)
    expect(rest[0]).toMatchObject({ where: { slug: { equals: 'made-up-alpha' } }, limit: 1 })
    // The exception: the creator's videos page for a person, so they keep their count for the totals.
    expect(paged.map((f) => f.collection)).toEqual(['videos'])
  })

  it('a video’s page: its one find sends no count', async () => {
    const r = await getVideo(req, { youtubeId: VIDEO_ID })
    expect(isError(r)).toBe(false)
    expect(r).toMatchObject({ video: { title: 'Made-up video' } })
    const { paged, rest } = inTransaction()
    expect(finds).toHaveLength(1)
    expect(paged).toEqual([])
    expect(rest.map((f) => f.collection)).toEqual(['videos'])
    expectUnpaginated(rest)
    expect(rest[0]).toMatchObject({ where: { youtubeId: { equals: VIDEO_ID } }, limit: 1 })
  })

  it('the creator list sends no count; the video grid is the only read that pages', async () => {
    expect(await listCreators(req)).toMatchObject({ creators: [{ name: 'Made-up Alpha' }, { name: 'Made-up Zulu' }] })
    let split = inTransaction()
    expect(finds).toHaveLength(1)
    expect(split.paged).toEqual([])
    expectUnpaginated(split.rest)

    finds = []
    expect(await listVideos(req, { page: 1 })).toMatchObject({ total: 1, page: 1, pages: 1 })
    split = inTransaction()
    expect(finds).toHaveLength(1)
    expect(split.rest).toEqual([])
    expect(split.paged.map((f) => f.collection)).toEqual(['videos'])
  })

  it('every public find is made with the request, as a signed-out visitor, with access checked', async () => {
    await listCreators(req)
    await listVideos(req)
    await getCreator(req, { slug: 'made-up-alpha' })
    await getVideo(req, { youtubeId: VIDEO_ID })
    expect(finds).toHaveLength(5)
    for (const f of finds) {
      expect(f.req, `the ${f.collection} find has its request`).toBeTruthy()
      expect((f.req as { user?: unknown }).user).toBeNull()
      expect(f.overrideAccess).toBe(false)
    }
  })
})

describe('the hooks that read inside a write’s transaction don’t paginate', () => {
  // Payload runs a collection's hooks in order, each getting the last one's answer.
  const beforeChange = async (data: Record<string, unknown>) => {
    let out = data
    for (const hook of creators.hooks!.beforeChange!) out = ((await hook({ data: out, operation: 'create', req, collection: creators, context: {} } as never)) as typeof out | undefined) ?? out
    return out
  }
  const afterChange = async (doc: Record<string, unknown>, previousDoc: Record<string, unknown>) => {
    for (const hook of creators.hooks!.afterChange!) await hook({ doc, previousDoc, data: doc, operation: 'update', req, collection: creators, context: {} } as never)
  }

  it('a new creator is put in its place by name with one find, and no count', async () => {
    const out = await beforeChange({ name: 'Made-up Mango', tenant: 'A', channels: [{ handle: '@madeupmango' }] })
    // Between Alpha (a1) and Zulu (a2): the find's rows were used.
    expect(String(out._order) > 'a1' && String(out._order) < 'a2').toBe(true)
    const { paged, rest } = inTransaction()
    expect(finds).toHaveLength(1)
    expect(paged).toEqual([])
    expect(rest.map((f) => f.collection)).toEqual(['creators'])
    expectUnpaginated(rest)
  })

  it('a creator’s mode change re-judges its videos with one find, and no count, in the same transaction', async () => {
    const before = rows.creators![0]!
    await afterChange({ ...before, videosDefault: 'rules' }, before)
    const { paged, rest } = inTransaction()
    expect(finds).toHaveLength(1)
    expect(paged).toEqual([])
    expect(rest.map((f) => f.collection)).toEqual(['videos'])
    expectUnpaginated(rest)
    // The find's rows were used: the one video moves to the creator's new mode, on the same request.
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ collection: 'videos', where: { id: { in: ['v1'] } }, data: { curation: 'rules' } })
    expect(updates[0]!.req!.transactionID).toBe(TRANSACTION)
  })

  it('a change that leaves the mode alone reads nothing', async () => {
    const before = rows.creators![0]!
    await afterChange({ ...before, name: 'Made-up Alpha, renamed' }, before)
    expect(finds).toEqual([])
    expect(updates).toEqual([])
  })
})
