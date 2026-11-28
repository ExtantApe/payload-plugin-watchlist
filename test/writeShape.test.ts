import { configToSchema } from '@payloadcms/graphql'
import { createRequire } from 'node:module'
import { createLocalReq, type CollectionBeforeChangeHook, type CollectionBeforeOperationHook, type Config, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { syncCreator } from '../src/index.js'
import { fakeYoutube } from './fakeYoutube.js'
import { as, channelId, person, startPayload, stopMongo, tokenOf, videoId, type Harness, type Person } from './harness.js'

// Write data has to be in the shape of the collection's fields, and a channel row pointed at a different channel
// starts over. Made-up data.

// The copy of graphql that builds Payload's schema (Node loads it as CommonJS; an import here would load a second one).
const { graphql } = createRequire(import.meta.url)('graphql') as typeof import('graphql')

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Slug = 'creators' | 'videos' | 'watchlist-usage'
const BAD_SHAPE = 'Watchlist couldn’t save this: the data isn’t in the shape of the collection’s fields.'
const FAR = '2099-01-01T00:00:00.000Z'
/** A well-formed id that no record has. */
const UNKNOWN = '0123456789abcdef01234567'

const yt = fakeYoutube()
const youtube = { apiKey: () => 'made-up-key', fetch: ((...a) => yt.fetch(...a)) as typeof fetch, sleep: async () => {}, dailyUnitCap: 1000 }

let n = 0
const next = (s: string) => `${s}${++n}`
const rawOf = async (payload: Payload, collection: Slug, id: unknown): Promise<Doc> => (await (payload.db as any).collections[collection].findById(String(id)).lean()) as Doc // eslint-disable-line @typescript-eslint/no-explicit-any
/** The whole stored record, as text, to show nothing in it changed. */
const snapshot = async (payload: Payload, collection: Slug, id: unknown) => JSON.stringify(await rawOf(payload, collection, id))
const makeCreator = async (payload: Payload, extra: Doc = {}): Promise<Doc> =>
  (await payload.create({ collection: 'creators', data: { tenant: 'A', name: next('Made-up creator '), videosDefault: 'rules', channels: [{ handle: next('@made-up-') }], ...extra } as never, depth: 0 })) as unknown as Doc
const makeVideo = async (payload: Payload, creator: unknown, extra: Doc = {}): Promise<Doc> =>
  (await payload.create({ collection: 'videos', data: { tenant: 'A', creator, youtubeId: videoId(next('ws')), title: 'Made-up video', ...extra } as never, depth: 0 })) as unknown as Doc

async function expectRefused(work: () => Promise<unknown>) {
  await expect(work()).rejects.toMatchObject({ message: BAD_SHAPE, status: 400 })
}
function expectRefusedByRest(r: { status: number; body: any }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  expect({ status: r.status, message: r.body?.errors?.[0]?.message }).toEqual({ status: 400, message: BAD_SHAPE })
}

afterAll(stopMongo)

describe('write data in the shape of the fields', () => {
  let h: Harness
  let payload: Payload
  let staff: Person, admin: Person
  const tokens: Record<string, string> = {}

  beforeAll(async () => {
    h = await startPayload((o) => ({ ...o, youtube, overrides: { videos: (c) => ({ ...c, fields: [...c.fields, { name: 'extra', type: 'json' as const }] }) } }))
    payload = h.payload
    staff = await person(payload, 'A', 'staff')
    admin = await person(payload, 'A', 'admin')
    for (const p of [staff, admin]) tokens[p.id] = await tokenOf(payload, p)
  })
  afterAll(async () => {
    await payload.destroy()
  })

  const rest = (path: string, method: string, body?: unknown, p: Person = staff) => h.rest(path, { method, body, token: tokens[p.id] })

  /** Every way of updating one record, each expected to be refused. */
  const updates = (collection: 'creators' | 'videos') =>
    [
      ['REST, staff', async (id: string, data: Doc) => expectRefusedByRest(await rest(`/${collection}/${id}`, 'PATCH', data))],
      ['REST, admin', async (id: string, data: Doc) => expectRefusedByRest(await rest(`/${collection}/${id}`, 'PATCH', data, admin))],
      ['Local API, access checked', (id: string, data: Doc) => expectRefused(() => payload.update({ collection, id, data: data as never, ...as(staff) }))],
      ['Local API, access overridden', (id: string, data: Doc) => expectRefused(() => payload.update({ collection, id, data: data as never, ...as(staff), overrideAccess: true }))],
      ['Local API, no person', (id: string, data: Doc) => expectRefused(() => payload.update({ collection, id, data: data as never }))],
    ] as const

  const operatorOnVideo = () => ({ $set: { claim: 'made-up-claim', passedRules: true, source: 'api', channelId: channelId('shape'), ruleKey: 'made-up-key' } })

  for (const [way, refuses] of updates('videos'))
    it(`${way}: a video update with an extra key outside its fields is refused, and nothing changes`, async () => {
      const video = await makeVideo(payload, (await makeCreator(payload)).id)
      const before = await snapshot(payload, 'videos', video.id)
      await refuses(String(video.id), operatorOnVideo())
      await refuses(String(video.id), { title: 'Made-up new title', ...operatorOnVideo() })
      expect(await snapshot(payload, 'videos', video.id)).toBe(before)
    })

  it('the answer is the same for an id no record has', async () => {
    const video = await makeVideo(payload, (await makeCreator(payload)).id)
    const real = await rest(`/videos/${video.id}`, 'PATCH', operatorOnVideo())
    const unknown = await rest(`/videos/${UNKNOWN}`, 'PATCH', operatorOnVideo())
    expectRefusedByRest(unknown)
    expect(unknown).toEqual(real)
    await expectRefused(() => payload.update({ collection: 'videos', id: UNKNOWN, data: operatorOnVideo() as never, ...as(staff) }))
  })

  it('a refused creator update changes nothing', async () => {
    const id = channelId(next('lock'))
    yt.addChannel(id, next('@made-up-lock'))
    const creator = await makeCreator(payload, { channels: [{ handle: `https://www.youtube.com/channel/${id}` }] })
    const before = await snapshot(payload, 'creators', creator.id)
    for (const [, refuses] of updates('creators')) await refuses(String(creator.id), { $set: { syncNote: 'made-up', syncingSince: FAR } })
    expect(await snapshot(payload, 'creators', creator.id)).toBe(before)
    await syncCreator(payload, String(creator.id))
    expect((await rawOf(payload, 'creators', creator.id)).lastSyncedAt).toBeTruthy()
  })

  it('a create that carries such a key is refused, and no record is made', async () => {
    const creator = await makeCreator(payload)
    const count = async () => [(await payload.count({ collection: 'creators' })).totalDocs, (await payload.count({ collection: 'videos' })).totalDocs]
    const before = await count()
    const newCreator = () => ({ tenant: 'A', name: next('Made-up refused '), channels: [{ handle: next('@made-up-') }], $set: { syncNote: 'made-up' } })
    const newVideo = () => ({ tenant: 'A', creator: creator.id, youtubeId: videoId(next('rf')), title: 'Made-up refused', $set: { claim: 'made-up' } })
    for (const [collection, data] of [['creators', newCreator], ['videos', newVideo]] as const) {
      expectRefusedByRest(await rest(`/${collection}`, 'POST', data()))
      await expectRefused(() => payload.create({ collection, data: data() as never, ...as(staff) }))
      await expectRefused(() => payload.create({ collection, data: data() as never }))
    }
    expect(await count()).toEqual(before)
  })

  it('a bulk update with such a key is refused, and none of the records change', async () => {
    const bio = next('Made-up bulk ')
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push(String((await makeCreator(payload, { bio })).id))
    const all = () => Promise.all(ids.map((id) => snapshot(payload, 'creators', id)))
    const before = await all()
    const data = { website: 'https://example.test', $set: { syncNote: 'made-up' } }
    expectRefusedByRest(await rest(`/creators?where[bio][equals]=${encodeURIComponent(bio)}`, 'PATCH', data))
    await expectRefused(() => payload.update({ collection: 'creators', where: { bio: { equals: bio } }, data: { ...data } as never, ...as(staff) }))
    await expectRefused(() => payload.update({ collection: 'creators', where: { bio: { equals: bio } }, data: { ...data } as never }))
    expect(await all()).toEqual(before)
  })

  it('such keys are refused inside rows and at the top level', async () => {
    const creator = await makeCreator(payload, { channels: [{ handle: '@made-up-depth', playlists: [{ playlist: 'PLmadeupdepth' }] }], shows: [{ playlist: 'PLmadeupshow' }] })
    const stored = await rawOf(payload, 'creators', creator.id)
    const channel = { id: String(stored.channels[0].id), handle: '@made-up-depth' }
    const playlist = { id: String(stored.channels[0].playlists[0].id), playlist: 'PLmadeupdepth', rule: 'exclude' }
    const show = { id: String(stored.shows[0].id), playlist: 'PLmadeupshow' }
    const before = await snapshot(payload, 'creators', creator.id)
    const bodies: Doc[] = []
    for (const extra of [{ $made: 'up' }, { 'made.up': 'x' }]) {
      bodies.push({ channels: [{ ...channel, ...extra }] })
      bodies.push({ shows: [{ ...show, ...extra }] })
      bodies.push({ channels: [{ ...channel, playlists: [{ ...playlist, ...extra }] }] })
    }
    bodies.push({ 'channels.0.uploads': 'UUmadeup' })
    for (const operator of ['$unset', '$rename', '$inc']) bodies.push({ [operator]: { minMinutes: 1 } })
    for (const body of bodies) {
      expectRefusedByRest(await rest(`/creators/${creator.id}`, 'PATCH', body))
      await expectRefused(() => payload.update({ collection: 'creators', id: String(creator.id), data: structuredClone(body) as never }))
    }
    expect(await snapshot(payload, 'creators', creator.id)).toBe(before)
  })

  it('the unit ledger takes the same rule', async () => {
    const before = (await payload.count({ collection: 'watchlist-usage' })).totalDocs
    await expectRefused(() => payload.create({ collection: 'watchlist-usage', data: { day: '2026-11-02', units: 1, $set: { units: 2 } } as never }))
    expect((await payload.count({ collection: 'watchlist-usage' })).totalDocs).toBe(before)
  })

  it('what a json field holds is stored as it is', async () => {
    const extra = { $x: 1, 'a.b': 2 }
    const video = await makeVideo(payload, (await makeCreator(payload)).id, { extra })
    expect((await rawOf(payload, 'videos', video.id)).extra).toEqual(extra)
    const changed = { $y: [{ 'c.d': 3 }] }
    const r = await rest(`/videos/${video.id}`, 'PATCH', { extra: changed })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect((await rawOf(payload, 'videos', video.id)).extra).toEqual(changed)
  })

  it('GraphQL create and update still work', async () => {
    const creator = await makeCreator(payload)
    const { schema } = configToSchema(payload.config)
    const run = async (source: string) => {
      const req = await createLocalReq({ user: staff as never }, payload)
      return graphql({ schema, source, contextValue: { req, headers: new Headers() } })
    }
    const made = await run(`mutation { createVideo(data: { tenant: "A", creator: "${creator.id}", youtubeId: "${videoId(next('gq'))}", title: "Made-up by GraphQL" }) { id } }`)
    expect(made.errors).toBeUndefined()
    const id = (made.data as Doc).createVideo.id
    const changed = await run(`mutation { updateVideo(id: "${id}", data: { title: "Made-up changed" }) { id } }`)
    expect(changed.errors).toBeUndefined()
    expect((await rawOf(payload, 'videos', id)).title).toBe('Made-up changed')
  })

  describe('what a list field takes', () => {
    const state = () => ({ uploads: 'UUmadeupsent', backfillToken: 'made-up-token', backfillDone: true, rssSeen: videoId('seen') })
    /** A creator with one channel, which has one playlist and stored sync state, and one show. */
    async function withLists() {
      const handle = next('@made-up-list-')
      const creator = await makeCreator(payload, { channels: [{ handle, uploads: 'UUmadeupkept', playlists: [{ playlist: 'PLmadeupinner' }] }], shows: [{ playlist: 'PLmadeupouter' }] })
      const stored = await rawOf(payload, 'creators', creator.id)
      return { id: String(creator.id), row: { id: String(stored.channels[0].id), handle } }
    }

    type Row = { id: string; handle: string }
    const refused: [string, (row: Row) => Doc][] = [
      ['channels as an object with a named key', (row) => ({ channels: { $push: { handle: row.handle, ...state() } } })],
      ['channels as an object with a numbered key', (row) => ({ channels: { 0: { id: row.id, ...state() } } })],
      ['channels as text', () => ({ channels: 'x' })],
      ['channels as false', () => ({ channels: false })],
      ['channels as empty text', () => ({ channels: '' })],
      ['shows as an object', () => ({ shows: { 0: { playlist: 'PLmadeupobject' } } })],
      ['a list inside a row as an object', (row) => ({ channels: [{ ...row, playlists: { 0: { playlist: 'PLmadeupobject' } } }] })],
    ]
    for (const [what, body] of refused)
      it(`refuses ${what}, and stores nothing`, async () => {
        const { id, row } = await withLists()
        const before = await snapshot(payload, 'creators', id)
        const count = async () => (await payload.count({ collection: 'creators' })).totalDocs
        const total = await count()
        const fresh = () => ({ tenant: 'A', name: next('Made-up refused list '), channels: [{ handle: next('@made-up-') }], ...body(row) })
        expectRefusedByRest(await rest(`/creators/${id}`, 'PATCH', body(row)))
        expectRefusedByRest(await rest('/creators', 'POST', fresh()))
        await expectRefused(() => payload.update({ collection: 'creators', id, data: body(row) as never, ...as(staff) }))
        await expectRefused(() => payload.create({ collection: 'creators', data: fresh() as never, ...as(staff) }))
        await expectRefused(() => payload.update({ collection: 'creators', id, data: body(row) as never }))
        expect(await snapshot(payload, 'creators', id)).toBe(before)
        expect(await count()).toBe(total)
      })

    for (const empty of [0, '0'] as const) {
      const sent = JSON.stringify(empty)
      it(`takes ${sent} as an empty list on an update, at the top level and inside a row`, async () => {
        const { id, row } = await withLists()
        for (const body of [{ shows: empty }, { channels: [{ ...row, playlists: empty }] }]) {
          const r = await rest(`/creators/${id}`, 'PATCH', body)
          expect(r.status, JSON.stringify(r.body)).toBe(200)
        }
        const stored = await rawOf(payload, 'creators', id)
        expect(stored.shows).toEqual([])
        expect(stored.channels[0].playlists).toEqual([])
      })

      it(`takes ${sent} as an empty list on a create, at the top level and inside a row`, async () => {
        const r = await rest('/creators', 'POST', { tenant: 'A', name: next('Made-up empty list '), channels: [{ handle: next('@made-up-'), playlists: empty }], shows: empty })
        expect(r.status, JSON.stringify(r.body)).toBe(201)
        const stored = await rawOf(payload, 'creators', r.body.doc.id)
        expect(stored.shows).toEqual([])
        expect(stored.channels[0].playlists).toEqual([])
      })
    }

    it('keeps the stored sync state when a row comes with an empty list sent as text', async () => {
      const { id, row } = await withLists()
      const r = await rest(`/creators/${id}`, 'PATCH', { channels: [{ ...row, uploads: 'UUmadeupsent', playlists: '0' }] })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      const stored = await rawOf(payload, 'creators', id)
      expect(stored.channels[0].uploads).toBe('UUmadeupkept')
      expect(stored.channels[0].playlists).toEqual([])
    })

    it('still clears a list sent as null', async () => {
      const { id } = await withLists()
      const r = await rest(`/creators/${id}`, 'PATCH', { channels: null })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect((await rawOf(payload, 'creators', id)).channels ?? []).toEqual([])
    })
  })

  describe('two rows of one list with the same id', () => {
    for (const list of ['channels', 'shows'] as const)
      it(`are refused in ${list}, and the stored rows stay`, async () => {
        const creator = await makeCreator(payload, { shows: [{ playlist: 'PLmadeupfirst' }] })
        const id = String((await rawOf(payload, 'creators', creator.id))[list][0].id)
        const row = (s: string) => (list === 'channels' ? { id, handle: `@made-up-${s}` } : { id, playlist: `PLmadeup${s}` })
        const data = () => ({ [list]: [row('one'), row('two')] })
        const before = await snapshot(payload, 'creators', creator.id)
        for (const [, refuses] of updates('creators')) await refuses(String(creator.id), data())
        expect(await snapshot(payload, 'creators', creator.id)).toBe(before)
      })

    it('are refused on a server create too', async () => {
      const before = (await payload.count({ collection: 'creators' })).totalDocs
      await expectRefused(() => makeCreator(payload, { channels: [{ id: UNKNOWN, handle: '@made-up-a' }, { id: UNKNOWN, handle: '@made-up-b' }] }))
      expect((await payload.count({ collection: 'creators' })).totalDocs).toBe(before)
    })
  })

  describe('a channel row pointed at a different channel', () => {
    const link = (id: string) => `https://www.youtube.com/channel/${id}`
    const lookups = () => yt.api().filter((c) => c.kind === 'channels')
    /** A made-up channel with one upload. */
    function channel(name: string) {
      const id = channelId(next(name))
      const handle = `@made-up-${name}-${n}`
      const ch = yt.addChannel(id, handle)
      const first = videoId(next(`${name}v`))
      yt.upload(id, { id: first, title: `Made-up from ${name}` })
      return { id, handle, uploads: ch.uploads, first }
    }
    const rowOf = async (id: unknown, i = 0): Promise<Doc> => (await rawOf(payload, 'creators', id)).channels[i]
    const imported = async (creator: unknown) => ((await payload.find({ collection: 'videos', where: { creator: { equals: creator } }, depth: 0, pagination: false })).docs as unknown as Doc[]).map((v) => v.youtubeId as string)
    /** The admin's way of saving: read the whole record, change it, send all of it back. */
    async function saveBack(id: unknown, change: (doc: Doc) => void) {
      const read = await rest(`/creators/${id}?depth=0`, 'GET')
      expect(read.status).toBe(200)
      change(read.body)
      const r = await rest(`/creators/${id}?depth=0`, 'PATCH', read.body)
      expect(r.status, JSON.stringify(r.body)).toBe(200)
    }
    async function synced(handle: string) {
      const creator = await makeCreator(payload, { channels: [{ handle }] })
      await syncCreator(payload, String(creator.id))
      // A page marker left from a backfill, so there's one to clear.
      await payload.update({ collection: 'creators', id: String(creator.id), data: { channels: [{ ...((await payload.findByID({ collection: 'creators', id: String(creator.id), depth: 0 })) as unknown as Doc).channels[0], backfillToken: 'made-up-token', rssSeen: videoId('seen') }] } as never })
      return creator
    }
    async function expectStartsOver(creator: Doc, a: ReturnType<typeof channel>, b: ReturnType<typeof channel>) {
      const moved = await rowOf(creator.id)
      expect(moved.channelId).toBe(b.id)
      for (const f of ['uploads', 'backfillToken', 'rssSeen']) expect(moved[f] ?? null, f).toBeNull()
      expect(moved.backfillDone === true).toBe(false)
      const late = videoId(next('late'))
      yt.upload(a.id, { id: late, title: 'Made-up later upload' })
      yt.reset()
      await syncCreator(payload, String(creator.id), { full: true })
      expect(lookups()).toHaveLength(1)
      expect((await rowOf(creator.id)).uploads).toBe(b.uploads)
      const videos = await imported(creator.id)
      expect(videos).toContain(b.first)
      expect(videos).not.toContain(late)
    }

    it('through the API, starts its sync over', async () => {
      const a = channel('apia'), b = channel('apib')
      const creator = await synced(link(a.id))
      const row = await rowOf(creator.id)
      expect(row.uploads).toBe(a.uploads)
      const r = await rest(`/creators/${creator.id}`, 'PATCH', { channels: [{ id: String(row.id), handle: link(b.id), uploads: a.uploads, backfillToken: 'made-up-token', backfillDone: true, rssSeen: row.rssSeen }] })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      await expectStartsOver(creator, a, b)
    })

    it('through the admin’s whole-record save, takes the new channel’s ID and starts over', async () => {
      const a = channel('forma'), b = channel('formb')
      const creator = await synced(link(a.id))
      await saveBack(creator.id, (doc) => {
        expect(doc.channels[0].channelId).toBe(a.id)
        doc.channels[0].handle = link(b.id)
      })
      await expectStartsOver(creator, a, b)
    })

    it('keeps its sync state when the new handle is the same channel’s link', async () => {
      const a = channel('same')
      const creator = await synced(a.handle)
      const before = await rowOf(creator.id)
      expect(before).toMatchObject({ channelId: a.id, uploads: a.uploads, backfillDone: true })
      await saveBack(creator.id, (doc) => {
        doc.channels[0].handle = link(a.id)
      })
      expect(await rowOf(creator.id)).toMatchObject({ handle: link(a.id), channelId: a.id, uploads: a.uploads, backfillDone: true, backfillToken: 'made-up-token', rssSeen: before.rssSeen })
      yt.reset()
      await syncCreator(payload, String(creator.id))
      expect(lookups()).toHaveLength(0)
    })

    it('rows saved in a new order each keep their own sync state', async () => {
      const a = channel('ordera'), b = channel('orderb')
      const creator = await makeCreator(payload, { channels: [{ handle: link(a.id) }, { handle: link(b.id) }] })
      await syncCreator(payload, String(creator.id))
      const before = (await rawOf(payload, 'creators', creator.id)).channels as Doc[]
      await saveBack(creator.id, (doc) => {
        doc.channels.reverse()
      })
      const after = (await rawOf(payload, 'creators', creator.id)).channels as Doc[]
      expect(after).toEqual([before[1], before[0]])
      expect(after.map((c) => c.uploads)).toEqual([b.uploads, a.uploads])
    })
  })
})

describe('hooks added after Watchlist', () => {
  let payload: Payload
  const on = { before: false, change: false }

  beforeAll(async () => {
    const early: CollectionBeforeOperationHook = ({ args, operation }) => {
      if (on.before && (operation === 'create' || operation === 'update')) return { ...args, data: { ...(args as { data?: object }).data, $set: { claim: 'made-up' } } }
    }
    const late: CollectionBeforeChangeHook = ({ data }) => (on.change ? { ...data, $set: { claim: 'made-up' } } : data)
    const plugin = (config: Config): Config => ({
      ...config,
      collections: (config.collections ?? []).map((c) => (c.slug === 'videos' ? { ...c, hooks: { ...c.hooks, beforeOperation: [...(c.hooks?.beforeOperation ?? []), early], beforeChange: [...(c.hooks?.beforeChange ?? []), late] } } : c)),
    })
    payload = (await startPayload((o) => o, { plugins: [plugin] })).payload
  })
  afterAll(async () => {
    await payload.destroy()
  })

  for (const kind of ['before', 'change'] as const)
    it(`what ${kind === 'before' ? 'a beforeOperation' : 'a beforeChange'} hook puts into the data is checked too`, async () => {
      const video = await makeVideo(payload, (await makeCreator(payload)).id)
      const before = await snapshot(payload, 'videos', video.id)
      on[kind] = true
      try {
        await expectRefused(() => payload.update({ collection: 'videos', id: String(video.id), data: { title: 'Made-up' } as never }))
        // An id no record has gets the same answer.
        if (kind === 'before') await expectRefused(() => payload.update({ collection: 'videos', id: UNKNOWN, data: { title: 'Made-up' } as never }))
      } finally {
        on[kind] = false
      }
      expect(await snapshot(payload, 'videos', video.id)).toBe(before)
    })
})

describe('with drafts turned on', () => {
  let payload: Payload
  let staff: Person

  beforeAll(async () => {
    payload = (await startPayload((o) => ({ ...o, overrides: { videos: (c) => ({ ...c, versions: { drafts: true } }) } }))).payload
    staff = await person(payload, 'A', 'staff')
  })
  afterAll(async () => {
    await payload.destroy()
  })

  it('a draft save and a restore both work, and the sync’s fields stay as stored', async () => {
    const kept = { hiddenReason: 'Made-up stored reason', ruleKey: 'made-up-stored', source: 'rss', channelId: channelId('draft') }
    const video = await makeVideo(payload, (await makeCreator(payload)).id, { _status: 'published', ...kept })
    await payload.update({ collection: 'videos', id: String(video.id), data: { title: 'Made-up second', _status: 'published' } as never })
    await payload.update({ collection: 'videos', id: String(video.id), draft: true, data: { title: 'Made-up draft', hiddenReason: 'Made-up from a person' } as never, ...as(staff) })
    const latest = async () => (await payload.findVersions({ collection: 'videos', where: { parent: { equals: video.id } }, sort: '-updatedAt', limit: 1, depth: 0 })).docs[0] as unknown as Doc
    expect((await latest()).version).toMatchObject({ title: 'Made-up draft', ...kept })
    const { docs } = await payload.findVersions({ collection: 'videos', where: { parent: { equals: video.id } }, sort: 'createdAt', limit: 1, depth: 0 })
    await payload.restoreVersion({ collection: 'videos', id: String(docs[0]!.id), ...as(staff) } as never)
    expect(await rawOf(payload, 'videos', video.id)).toMatchObject({ title: 'Made-up video', ...kept })
  })
})
