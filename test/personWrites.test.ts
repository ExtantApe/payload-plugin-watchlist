import { createLocalReq, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { reviewVideo, sweepGoneVideos, syncCreator } from '../src/index.js'
import { fakeYoutube } from './fakeYoutube.js'
import { as, channelId, person, startPayload, stopMongo, tokenOf, videoId, type Harness, type Person } from './harness.js'

// What the sync and the review keep for themselves: a person's write never sets it. Server code and the plugin's own
// writes still do. Made-up data.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
let h: Harness
let payload: Payload
let curator: Person, staff: Person, admin: Person
const tokens: Record<string, string> = {}
const revalidated: string[] = []
const yt = fakeYoutube()

const stored = async (collection: 'creators' | 'videos', id: unknown): Promise<Doc> => (await (payload.db as any).collections[collection].findById(String(id)).lean()) as Doc // eslint-disable-line @typescript-eslint/no-explicit-any
const unset = (v: unknown) => v === undefined || v === null || (Array.isArray(v) && v.length === 0)
const iso = (v: unknown) => (unset(v) ? null : new Date(v as string).toISOString())

let n = 0
const next = (s: string) => `${s}${++n}`

const FAR = '2099-01-01T00:00:00.000Z'
/** Everything on a video that only the sync or the review writes. */
const videoState = () => ({
  claim: 'made-up-person:made-up-claim',
  hiddenReason: 'Made-up reason',
  ruleKey: 'made-up-rule-key',
  passedRules: true,
  source: 'api',
  curation: 'rules',
  unavailable: true,
  unavailableSince: FAR,
  channelId: channelId('other'),
  embeddable: true,
  madeForKids: true,
  speciesNames: ['Made-up name'],
})
const CREATOR_STATE = { syncNote: 'Made-up note from nowhere', lastSyncedAt: FAR, lastRecheckAt: FAR, lastFullSyncAt: FAR, syncingSince: FAR }
const CHANNEL_STATE = { uploads: 'UUmadeupother', backfillToken: 'made-up-token', backfillDone: true, rssSeen: videoId('seen') }

function expectNoVideoState(v: Doc) {
  for (const f of ['claim', 'hiddenReason', 'ruleKey', 'source', 'unavailableSince', 'channelId', 'speciesNames']) expect(unset(v[f]), `${f}: ${JSON.stringify(v[f])}`).toBe(true)
  for (const f of ['passedRules', 'unavailable', 'embeddable', 'madeForKids']) expect(v[f] === true, f).toBe(false)
}
function expectNoCreatorState(c: Doc) {
  for (const f of Object.keys(CREATOR_STATE)) expect(unset(c[f]), `${f}: ${JSON.stringify(c[f])}`).toBe(true)
  for (const ch of c.channels as Doc[]) {
    for (const f of ['uploads', 'backfillToken', 'rssSeen']) expect(unset(ch[f]), `channels.${f}`).toBe(true)
    expect(ch.backfillDone === true, 'channels.backfillDone').toBe(false)
  }
}

const channel = (extra: Doc = {}) => ({ handle: next('@made-up-'), ...extra })
const serverCreator = async (extra: Doc = {}): Promise<Doc> => (await payload.create({ collection: 'creators', data: { tenant: 'A', name: next('Made-up creator '), videosDefault: 'picked', channels: [channel()], ...extra } as never, depth: 0 })) as unknown as Doc
const serverVideo = async (creator: unknown, extra: Doc = {}): Promise<Doc> => (await payload.create({ collection: 'videos', data: { tenant: 'A', creator, youtubeId: videoId(next('sv')), title: 'Made-up video', ...extra } as never, depth: 0 })) as unknown as Doc

beforeAll(async () => {
  h = await startPayload((o) => ({ ...o, goneVideos: { mode: 'clear' }, topics: { relationTo: 'taxa', resolve: () => null }, revalidate: ({ tag }) => void revalidated.push(tag), youtube: { apiKey: () => 'made-up-key', fetch: (...a) => yt.fetch(...a), sleep: async () => {}, dailyUnitCap: 100 } }), { collections: [{ slug: 'taxa', fields: [{ name: 'name', type: 'text' }] }] })
  payload = h.payload
  curator = await person(payload, 'A', 'curator')
  staff = await person(payload, 'A', 'staff')
  admin = await person(payload, 'A', 'admin')
  for (const p of [curator, staff, admin]) tokens[p.id] = await tokenOf(payload, p)
})
afterAll(async () => {
  await payload.destroy()
  await stopMongo()
})

/** The ways a person writes: REST, the Local API with access checked, and the Local API with a person and no access check. */
const WAYS = ['REST', 'Local API', 'Local API, access overridden'] as const
type Way = (typeof WAYS)[number]
async function create(way: Way, p: Person, collection: 'creators' | 'videos', data: Doc): Promise<Doc> {
  if (way === 'REST') {
    const r = await h.rest(`/${collection}?depth=0`, { method: 'POST', token: tokens[p.id], body: data })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    return r.body.doc
  }
  return (await payload.create({ collection, data: data as never, depth: 0, ...as(p), ...(way === 'Local API' ? {} : { overrideAccess: true }) })) as unknown as Doc
}
async function update(way: Way, p: Person, collection: 'creators' | 'videos', id: unknown, data: Doc): Promise<void> {
  if (way === 'REST') {
    const r = await h.rest(`/${collection}/${id}?depth=0`, { method: 'PATCH', token: tokens[p.id], body: data })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    return
  }
  await payload.update({ collection, id: String(id), data: data as never, depth: 0, ...as(p), ...(way === 'Local API' ? {} : { overrideAccess: true }) })
}

describe('a person creating a record', () => {
  for (const who of ['staff', 'admin'] as const)
    for (const way of WAYS) {
      const p = () => (who === 'staff' ? staff : admin)

      it(`${way}, ${who}: a new video takes none of what the sync and the review write`, async () => {
        const creator = await serverCreator({ videosDefault: 'rules' })
        const doc = await create(way, p(), 'videos', { tenant: 'A', creator: creator.id, youtubeId: videoId(next('pv')), title: 'Made-up by a person', ...videoState() })
        const v = await stored('videos', doc.id)
        expectNoVideoState(v)
        expect(v.curation).toBe('rules') // from the creator
        expect(v.shown).toBe(false) // nothing says it passed the rules
        expect(v.locked).toBe(true)
      })

      it(`${way}, ${who}: a new creator takes no sync state, and keeps the person’s own settings`, async () => {
        const notes = { doNotFeature: true, doNotFeatureNote: 'Made-up: asked by letter', syncDays: ['mon'], syncHour: 3, bio: 'Made-up bio' }
        const doc = await create(way, p(), 'creators', {
          tenant: 'A',
          name: next('Made-up by a person '),
          ...CREATOR_STATE,
          ...notes,
          channels: [channel({ ...CHANNEL_STATE, excludeKeywords: 'made-up', minMinutes: 2, speciesMode: 'never' })],
        })
        const c = await stored('creators', doc.id)
        expectNoCreatorState(c)
        expect(c).toMatchObject(notes)
        expect(c.channels[0]).toMatchObject({ excludeKeywords: 'made-up', minMinutes: 2, speciesMode: 'never' })
      })
    }

  it('Shown on a new video still works as the person’s own choice', async () => {
    const creator = await serverCreator()
    const doc = await create('REST', staff, 'videos', { tenant: 'A', creator: creator.id, youtubeId: videoId(next('ch')), title: 'Made-up pick', shown: true })
    expect(await stored('videos', doc.id)).toMatchObject({ choice: 'show', shown: true })
  })

  it('a curator on the site takes the claim of a video a person created', async () => {
    const creator = await serverCreator()
    const doc = await create('REST', staff, 'videos', { tenant: 'A', creator: creator.id, youtubeId: videoId(next('rv')), title: 'Made-up to review', ...videoState() })
    const req = await createLocalReq({ user: curator as never }, payload)
    await expect(reviewVideo(payload, { req, id: String(doc.id), choice: 'show' })).resolves.toMatchObject({ choice: 'show', shown: true })
    expect(String((await stored('videos', doc.id)).claim)).toContain(`${curator.id}:`)
  })
})

describe('a person updating a record', () => {
  const kept = { hiddenReason: 'Made-up stored reason', ruleKey: 'made-up-stored', passedRules: false, source: 'rss', channelId: channelId('mine'), unavailable: false, embeddable: false, madeForKids: false, speciesNames: ['Made-up stored'] }
  for (const who of ['staff', 'admin'] as const)
    for (const way of WAYS) {
      const p = () => (who === 'staff' ? staff : admin)

      it(`${way}, ${who}: a video keeps what the sync and the review wrote`, async () => {
        const creator = await serverCreator()
        const made = await serverVideo(creator.id, kept)
        await update(way, p(), 'videos', made.id, { title: 'Made-up new title', ...videoState() })
        const v = await stored('videos', made.id)
        expect(v).toMatchObject({ ...kept, title: 'Made-up new title', curation: 'picked', shown: false })
        expect(unset(v.claim)).toBe(true)
        expect(unset(v.unavailableSince)).toBe(true)
      })

      it(`${way}, ${who}: a creator keeps its sync state, on the creator and on each channel`, async () => {
        const state = { syncNote: 'Made-up stored note', lastSyncedAt: '2026-11-01T00:00:00.000Z', lastRecheckAt: '2026-11-02T00:00:00.000Z', lastFullSyncAt: '2026-11-03T00:00:00.000Z' }
        const mine = { uploads: 'UUmadeupmine', backfillToken: 'made-up-mine', backfillDone: false, rssSeen: videoId('mine') }
        const made = await serverCreator({ ...state, channels: [channel(mine)] })
        const row = (made.channels as Doc[])[0]!
        await update(way, p(), 'creators', made.id, { doNotFeatureNote: 'Made-up staff note', ...CREATOR_STATE, channels: [{ ...row, minMinutes: 5, ...CHANNEL_STATE }, channel(CHANNEL_STATE)] })
        const c = await stored('creators', made.id)
        expect({ lastSyncedAt: iso(c.lastSyncedAt), lastRecheckAt: iso(c.lastRecheckAt), lastFullSyncAt: iso(c.lastFullSyncAt), syncNote: c.syncNote }).toEqual(state)
        expect(unset(c.syncingSince)).toBe(true)
        expect(c.doNotFeatureNote).toBe('Made-up staff note')
        expect(c.channels[0]).toMatchObject({ ...mine, minMinutes: 5 })
        for (const f of ['uploads', 'backfillToken', 'rssSeen']) expect(unset(c.channels[1][f]), f).toBe(true)
        expect(c.channels[1].backfillDone === true).toBe(false)
      })
    }

  it('saving a whole record back, as the admin form does, changes none of it', async () => {
    const made = await serverCreator({ syncNote: 'Made-up stored note', lastSyncedAt: '2026-11-01T00:00:00.000Z', channels: [channel({ uploads: 'UUmadeupform', backfillDone: true })] })
    const read = (await h.rest(`/creators/${made.id}?depth=0`, { token: tokens[staff.id] })).body as Doc
    await update('REST', staff, 'creators', made.id, { ...read, bio: 'Made-up new bio' })
    expect(await stored('creators', made.id)).toMatchObject({ bio: 'Made-up new bio', syncNote: 'Made-up stored note', channels: [{ uploads: 'UUmadeupform', backfillDone: true }] })
  })

  it('a curator is still refused a change to the sync’s fields', async () => {
    const creator = await serverCreator()
    const made = await serverVideo(creator.id)
    const r = await h.rest(`/videos/${made.id}`, { method: 'PATCH', token: tokens[curator.id], body: { hiddenReason: 'Made-up', kind: 'care' } })
    expect(r.status).toBe(403)
  })

  it('REST, one request over several records: each keeps its sync state, with a change that re-judges videos', async () => {
    const group = next('Made-up bulk ')
    const made = [await serverCreator({ website: `https://example.test/${n}`, bio: group }), await serverCreator({ bio: group }), await serverCreator({ bio: group })]
    for (const c of made) await serverVideo(c.id)
    const r = await h.rest(`/creators?where[bio][equals]=${encodeURIComponent(group)}&depth=0`, { method: 'PATCH', token: tokens[staff.id], body: { videosDefault: 'rules', ...CREATOR_STATE } })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.docs).toHaveLength(3)
    for (const c of made) {
      const s = await stored('creators', c.id)
      expect(s.videosDefault).toBe('rules')
      for (const f of Object.keys(CREATOR_STATE)) expect(unset(s[f]), f).toBe(true)
    }
  })
})

describe('one request that makes several writes', () => {
  it('stays a person’s request after a change that re-judges videos', async () => {
    const made = await serverCreator()
    await serverVideo(made.id)
    const req = await createLocalReq({ user: staff as never }, payload)
    revalidated.length = 0
    await payload.update({ collection: 'creators', id: String(made.id), data: { videosDefault: 'rules' } as never, overrideAccess: false, user: staff as never, req, depth: 0 })
    expect(revalidated).toContain('creators')
    await payload.update({ collection: 'creators', id: String(made.id), data: CREATOR_STATE as never, overrideAccess: false, user: staff as never, req, depth: 0 })
    const s = await stored('creators', made.id)
    for (const f of Object.keys(CREATOR_STATE)) expect(unset(s[f]), f).toBe(true)
  })

  it('stays a person’s request after a sweep of gone videos run on it', async () => {
    const made = await serverCreator()
    await serverVideo(made.id, { unavailable: true, unavailableSince: '2020-01-01T00:00:00.000Z' })
    const req = await createLocalReq({ user: staff as never }, payload)
    expect((await sweepGoneVideos(payload, { req })).cleared).toBeGreaterThan(0)
    await payload.update({ collection: 'creators', id: String(made.id), data: CREATOR_STATE as never, overrideAccess: false, user: staff as never, req, depth: 0 })
    const s = await stored('creators', made.id)
    for (const f of Object.keys(CREATOR_STATE)) expect(unset(s[f]), f).toBe(true)
  })

  it('stays a person’s request after a sync run on it', async () => {
    const made = await serverCreator({ channels: [{ handle: `https://www.youtube.com/channel/${channelId('run')}` }] })
    const req = await createLocalReq({ user: staff as never }, payload)
    await syncCreator(payload, String(made.id), { req })
    expect((await stored('creators', made.id)).lastSyncedAt).toBeTruthy()
    const doc = (await payload.create({ collection: 'videos', data: { tenant: 'A', creator: made.id, youtubeId: videoId(next('af')), title: 'Made-up after a sync', ...videoState() } as never, overrideAccess: false, user: staff as never, req, depth: 0 })) as unknown as Doc
    expectNoVideoState(await stored('videos', doc.id))
  })
})

describe('write data outside the shape of the fields', () => {
  const BAD_SHAPE = 'Watchlist couldn’t save this: the data isn’t in the shape of the collection’s fields.'
  const dottedVideo = { 'claim.x': 'made-up', 'hiddenReason.x': 'made-up', 'passedRules.x': true }
  const dottedCreator = { 'syncNote.x': 'made-up', 'syncingSince.x': FAR }
  const dottedRow = { 'channels.0.rssSeen': videoId('dot'), 'channels.0.uploads': 'UUdotted' }

  /** The write is refused with the one answer for data out of shape. */
  async function refused(way: Way, p: Person, collection: 'creators' | 'videos', id: unknown, data: Doc) {
    if (way === 'REST') {
      const r = await h.rest(id ? `/${collection}/${id}?depth=0` : `/${collection}?depth=0`, { method: id ? 'PATCH' : 'POST', token: tokens[p.id], body: data })
      expect({ status: r.status, message: r.body?.errors?.[0]?.message }).toEqual({ status: 400, message: BAD_SHAPE })
      return
    }
    await expect(id ? update(way, p, collection, id, data) : create(way, p, collection, data)).rejects.toMatchObject({ status: 400, message: BAD_SHAPE })
  }

  for (const way of WAYS) {
    it(`${way}: a new record with dotted keys is refused`, async () => {
      const creator = await serverCreator()
      const name = next('Made-up dotted ')
      await refused(way, staff, 'creators', null, { tenant: 'A', name, channels: [channel()], ...dottedCreator })
      await refused(way, staff, 'creators', null, { tenant: 'A', name, channels: [channel()], ...dottedRow })
      expect((await payload.find({ collection: 'creators', where: { name: { equals: name } }, depth: 0 })).docs).toHaveLength(0)
      const youtubeId = videoId(next('dk'))
      await refused(way, staff, 'videos', null, { tenant: 'A', creator: creator.id, youtubeId, title: 'Made-up dotted', ...dottedVideo })
      expect((await payload.find({ collection: 'videos', where: { youtubeId: { equals: youtubeId } }, depth: 0 })).docs).toHaveLength(0)
    })

    it(`${way}: an update with dotted keys is refused, and nothing changes`, async () => {
      const made = await serverCreator()
      const video = await serverVideo(made.id)
      const before = [await stored('creators', made.id), await stored('videos', video.id)]
      await refused(way, staff, 'creators', made.id, { bio: 'Made-up bio', ...dottedCreator })
      await refused(way, staff, 'creators', made.id, { ...dottedRow })
      await refused(way, staff, 'videos', video.id, { title: 'Made-up dotted', ...dottedVideo })
      expect([await stored('creators', made.id), await stored('videos', video.id)]).toEqual(before)
    })

    it(`${way}: a list field sent as an object is refused, and nothing changes`, async () => {
      const made = await serverCreator()
      const before = await stored('creators', made.id)
      await refused(way, staff, 'creators', made.id, { channels: { $push: { id: next('0123456789abcdef'), ...channel(CHANNEL_STATE) } } })
      expect(await stored('creators', made.id)).toEqual(before)
    })
  }
})

describe('server code and the sync still write all of it', () => {
  it('a server write with no person sets every field', async () => {
    const creator = await serverCreator({ ...CREATOR_STATE, channels: [channel(CHANNEL_STATE)] })
    const c = await stored('creators', creator.id)
    expect(c.syncNote).toBe(CREATOR_STATE.syncNote)
    expect(iso(c.syncingSince)).toBe(FAR)
    expect(c.channels[0]).toMatchObject(CHANNEL_STATE)
    const video = await serverVideo(creator.id, videoState())
    const { curation: _computed, ...rest } = videoState()
    const v = await stored('videos', video.id)
    expect({ ...v, unavailableSince: iso(v.unavailableSince) }).toMatchObject(rest)
    await payload.update({ collection: 'videos', id: String(video.id), data: { hiddenReason: 'Made-up changed', passedRules: false } as never })
    expect(await stored('videos', video.id)).toMatchObject({ hiddenReason: 'Made-up changed', passedRules: false })
  })

  it('a sync started by a person writes its state and its videos', async () => {
    const id = channelId('synced')
    const made = await serverCreator({ videosDefault: 'rules', channels: [{ handle: `https://www.youtube.com/channel/${id}` }] })
    yt.addChannel(id, '@made-up-synced', 'Made-up synced')
    yt.upload(id, { id: videoId('synced1'), title: 'Made-up upload' })
    const req = await createLocalReq({ user: staff as never }, payload)
    const report = await syncCreator(payload, String(made.id), { req })
    expect(report.added).toBe(1)
    const c = await stored('creators', made.id)
    expect(c.lastSyncedAt).toBeTruthy()
    expect(c.channels[0].uploads).toBeTruthy()
    expect(c.channels[0].backfillDone).toBe(true)
    const { docs } = await payload.find({ collection: 'videos', where: { creator: { equals: made.id } }, depth: 0 })
    expect(docs[0]).toMatchObject({ source: 'api', channelId: id })
    expect((docs[0] as Doc).ruleKey).toBeTruthy()
    expect((docs[0] as Doc).hiddenReason).toBeTruthy()
  })
})
