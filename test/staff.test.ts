import { createLocalReq, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { GONE_TITLE, reviewQueueCount, sendReviewDigest, sweepGoneVideos, syncDue, syncNow, type Classified, type WatchlistNotice } from '../src/index.js'
import { reviewQueue } from '../src/server/index.js'
import { fakeYoutube } from './fakeYoutube.js'
import { channelId, person, startPayload, stopMongo, tokenOf, videoId, type Harness, type Person } from './harness.js'
import { networkCalls } from './setup.js'

// Phase 2, the staff side: Sync now (an editor's button, the same ledger, cap and run lock), the curator's review queue
// and its count, the review route, the digest's retry, and the gone-videos sweep. Made-up people, sites, channels and
// videos; a made-up YouTube; nothing reaches the network.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const KEY = 'made-up-key-phase-2'
const CAP = 50
const SITE_CAP = 20
let h: Harness
let payload: Payload
let member: Person, curator: Person, curator2: Person, staff: Person, staffB: Person, curatorB: Person, admin: Person
const tokens: Record<string, string> = {}
const ids: Record<string, string> = {}
const notices: WatchlistNotice[] = []
const yt = fakeYoutube()
const state = { key: KEY as string | null, enabled: true as unknown, notifyFails: false, slowMs: 0 }
const topicIds: Record<string, string> = {}

const reqOf = (p: Person | null, site?: string) => createLocalReq({ user: (p ?? undefined) as never, context: site ? { site } : {} }, payload)
const raw = (slug: string) => (payload.db as unknown as { collections: Record<string, { collection: { findOne: (f: object) => Promise<Doc | null>; updateOne: (f: object, u: object, o?: object) => Promise<unknown>; deleteMany: (f: object) => Promise<unknown> } }> }).collections[slug]!.collection
/** Ends a creator's rest after a sync, as if the cooldown had passed. */
const rested = (id: string) => (payload.db as unknown as { collections: Record<string, { updateOne: (f: object, u: object) => Promise<unknown> }> }).collections.creators!.updateOne({ _id: id }, { $set: { lastSyncedAt: new Date(Date.now() - 3600_000) } })
const clearUsage = () => raw('watchlist-usage').deleteMany({})
const usage = async () => { const d = await raw('watchlist-usage').findOne({}); return d ? [d] : [] }
const post = (path: string, p: Person | null, body?: unknown) => h.rest(path, { method: 'POST', token: p ? tokens[p.id] : undefined, site: p ? undefined : 'A', body })
const video = (id: string) => payload.findByID({ collection: 'videos', id, overrideAccess: true, depth: 0 }) as unknown as Promise<Doc>
let seq = 0
async function waiting(site: 'A' | 'B', creator: string) {
  const key = `w${++seq}`
  return String((await payload.create({ collection: 'videos', data: { tenant: site, creator, youtubeId: videoId(key), title: `Made-up waiting ${key}`, description: 'Made-up description', passedRules: true, source: 'api', hiddenReason: 'Made-up reason' } as never })).id)
}

function options(mode: 'keep' | 'clear') {
  return (o: Parameters<Parameters<typeof startPayload>[0] & object>[0]) => ({
    ...o,
    enabled: () => state.enabled as boolean,
    notify: async (n: WatchlistNotice) => {
      if (state.notifyFails) throw new Error('made-up send failure')
      notices.push(n)
    },
    curation: { urgentAt: 3 },
    goneVideos: { mode, clearAfterDays: 30 },
    topics: { relationTo: 'taxa', field: 'species', stateField: 'speciesState', namesField: 'speciesNames', modeField: 'speciesMode', titlesField: 'speciesTitles', playlistRule: 'species', resolve: () => null },
    classify: async (videos: { key: string }[]) => new Map<string, Classified>(videos.map((v) => [v.key, { kind: 'care' }])),
    youtube: {
      apiKey: () => state.key,
      fetch: (async (...a: Parameters<typeof fetch>) => {
        if (state.slowMs) await new Promise((r) => setTimeout(r, state.slowMs))
        return yt.fetch(...a)
      }) as typeof fetch,
      sleep: async () => {},
      dailyUnitCap: CAP,
      siteDailyUnitCap: SITE_CAP,
    },
  })
}
const TAXA = { collections: [{ slug: 'taxa', fields: [{ name: 'name', type: 'text' as const }] }] }

beforeAll(async () => {
  h = await startPayload(options('clear') as never, TAXA)
  payload = h.payload
  member = await person(payload, 'A')
  curator = await person(payload, 'A', 'curator')
  curator2 = await person(payload, 'A', 'curator')
  curatorB = await person(payload, 'B', 'curator')
  staff = await person(payload, 'A', 'staff')
  staffB = await person(payload, 'B', 'staff')
  admin = await person(payload, 'A', 'admin')
  for (const p of [member, curator, curator2, curatorB, staff, staffB, admin]) tokens[p.id] = await tokenOf(payload, p)
  topicIds.one = String((await payload.create({ collection: 'taxa', data: { name: 'Madeupus one' } as never })).id)
  yt.addChannel(channelId('now'), '@now')
  yt.upload(channelId('now'), { id: videoId('now1'), title: 'Made-up now one' })
  yt.upload(channelId('now'), { id: videoId('now2'), title: 'Made-up now two' })
  ids.now = String((await payload.create({ collection: 'creators', data: { tenant: 'A', name: 'Made-up now', videosDefault: 'rules', channels: [{ handle: '@now' }] } as never })).id)
  ids.pickedA = String((await payload.create({ collection: 'creators', data: { tenant: 'A', name: 'Made-up picked A', videosDefault: 'picked', channels: [{ handle: '@pa' }] } as never })).id)
  ids.pickedB = String((await payload.create({ collection: 'creators', data: { tenant: 'B', name: 'Made-up picked B', videosDefault: 'picked', channels: [{ handle: '@pb' }] } as never })).id)
})
afterAll(async () => {
  await payload.destroy()
  await stopMongo()
})
beforeEach(async () => {
  Object.assign(state, { key: KEY, enabled: true, notifyFails: false, slowMs: 0 })
  notices.length = 0
  yt.reset()
  yt.failNext.length = 0
  await clearUsage()
})

describe('Sync now', () => {
  it('refuses a signed-out visitor, a member, a curator and another site’s editor, and starts nothing', async () => {
    expect((await post(`/creators/${ids.now}/sync`, null)).status).toBe(401)
    expect((await post(`/creators/${ids.now}/sync`, member)).status).toBe(403)
    expect((await post(`/creators/${ids.now}/sync`, curator)).status).toBe(403)
    // Another site's editor gets the same answer as for a creator that doesn't exist.
    const other = await post(`/creators/${ids.now}/sync`, staffB)
    const missing = await post(`/creators/aaaaaaaaaaaaaaaaaaaaaaaa/sync`, staffB)
    expect(other.status).toBe(404)
    expect(other.body).toEqual(missing.body)
    expect((await post(`/creators/not-an-id/sync`, staff)).status).toBe(404)
    expect(yt.calls).toEqual([])
    expect(await usage()).toEqual([])
    expect((await payload.find({ collection: 'videos', where: { creator: { equals: ids.now } }, overrideAccess: true })).totalDocs).toBe(0)
    expect((await payload.findByID({ collection: 'creators', id: ids.now!, overrideAccess: true })).syncingSince ?? null).toBeNull()
  })

  it('a provider that answers anything but what’s asked is a no', async () => {
    const odd = { ...staff, role: 'odd' }
    await expect(syncNow(payload, { req: await reqOf(odd as never), id: ids.now! })).rejects.toMatchObject({ status: 403 })
    await expect(syncNow(payload, { req: { payload, context: {} } as unknown as PayloadRequest, id: ids.now! })).rejects.toMatchObject({ status: 401 })
  })

  it('an editor of the site syncs through the unit ledger, and nothing new is stored on the creator', async () => {
    const r = await post(`/creators/${ids.now}/sync`, staff)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ added: 2, passed: 2, stopped: null })
    expect(r.body.units).toBeGreaterThan(0)
    expect(JSON.stringify(r.body)).not.toContain(KEY)
    const [day] = await usage()
    expect(day!.units).toBe(r.body.units)
    expect(day!.bySite).toEqual({ s_A: r.body.units })
    const stored = await raw('creators').findOne({ name: 'Made-up now' })
    expect(Object.keys(stored!)).not.toContain('syncNow')
    expect(stored!.syncingSince ?? null).toBeNull()
    // An admin may too.
    await rested(ids.now!)
    expect((await post(`/creators/${ids.now}/sync`, admin)).status).toBe(200)
    expect(networkCalls).toEqual([])
  })

  it('stays inside the daily cap: at the cap it stops cleanly and spends nothing', async () => {
    await rested(ids.now!)
    await post(`/creators/${ids.now}/sync`, staff)
    await raw('watchlist-usage').updateOne({}, { $set: { units: CAP } })
    await rested(ids.now!)
    yt.reset()
    const r = await post(`/creators/${ids.now}/sync`, staff)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ stopped: 'cap', units: 0 })
    expect(yt.api()).toEqual([])
    expect((await usage())[0]!.units).toBe(CAP)
  })

  it('two clicks at once run one sync: the other gets a 409 and starts nothing', async () => {
    yt.addChannel(channelId('race'), '@race')
    for (let i = 0; i < 3; i++) yt.upload(channelId('race'), { id: videoId(`race${i}`), title: `Made-up race ${i}` })
    const c = String((await payload.create({ collection: 'creators', data: { tenant: 'A', name: 'Made-up race', videosDefault: 'rules', channels: [{ handle: '@race' }] } as never })).id)
    state.slowMs = 25
    const results = await Promise.allSettled([syncNow(payload, { req: await reqOf(staff), id: c }), syncNow(payload, { req: await reqOf(admin), id: c })])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409 })
    // One run's calls only: the channel is looked up once, and each video is stored once.
    expect(yt.api().filter((x) => x.kind === 'channels')).toHaveLength(1)
    expect((await payload.find({ collection: 'videos', where: { creator: { equals: c } }, overrideAccess: true })).totalDocs).toBe(3)
    const won = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ units: number }>).value
    expect((await usage())[0]!.units).toBe(won.units)
    // Over REST too.
    await rested(c)
    state.slowMs = 25
    const rest = await Promise.all([post(`/creators/${c}/sync`, staff), post(`/creators/${c}/sync`, staff)])
    expect(rest.map((r) => r.status).sort()).toEqual([200, 409])
  })

  it('with outside calls off, or for a creator who asked out, it says so and calls nothing', async () => {
    await rested(ids.now!)
    state.enabled = 'true'
    expect((await post(`/creators/${ids.now}/sync`, staff)).status).toBe(400)
    state.enabled = true
    const out = String((await payload.create({ collection: 'creators', data: { tenant: 'A', name: 'Made-up asked out', doNotFeature: true, channels: [{ handle: '@out' }] } as never })).id)
    const r = await post(`/creators/${out}/sync`, staff)
    expect(r.status).toBe(400)
    expect(r.body.errors[0].message).toMatch(/asked not to be featured/)
    expect(yt.calls).toEqual([])
  })

  it('a creator rests after any sync: a click inside the cooldown gets a 429 that says when to try again, and spends nothing', async () => {
    await rested(ids.now!)
    expect((await post(`/creators/${ids.now}/sync`, staff)).status).toBe(200)
    const spent = (await usage())[0]!.units
    yt.reset()
    for (const p of [staff, admin]) {
      const again = await post(`/creators/${ids.now}/sync`, p)
      expect(again.status).toBe(429)
      expect(again.body.errors[0].message).toBe('This creator was synced a moment ago. Try again in 10 minutes.')
      expect(again.body.retryAfter).toBeGreaterThan(590)
      expect(again.body.retryAfter).toBeLessThanOrEqual(600)
    }
    expect(yt.calls).toEqual([])
    expect((await usage())[0]!.units).toBe(spent)
    expect((await payload.findByID({ collection: 'creators', id: ids.now!, overrideAccess: true })).syncingSince ?? null).toBeNull()
    // The cron's sync counts too: three minutes after any sync, seven are left.
    const at = new Date('2027-01-05T12:00:00Z')
    await (payload.db as unknown as { collections: Record<string, { updateOne: (f: object, u: object) => Promise<unknown> }> }).collections.creators!.updateOne({ _id: ids.now }, { $set: { lastSyncedAt: new Date(at.getTime() - 3 * 60_000) } })
    await expect(syncNow(payload, { req: await reqOf(staff), id: ids.now!, now: at })).rejects.toMatchObject({ status: 429, message: 'This creator was synced a moment ago. Try again in 7 minutes.', data: { retryAfter: 420 } })
    await expect(syncNow(payload, { req: await reqOf(staff), id: ids.now!, now: new Date(at.getTime() + 6.5 * 60_000) })).rejects.toMatchObject({ status: 429, message: 'This creator was synced a moment ago. Try again in under a minute.', data: { retryAfter: 30 } })
    // Once it has passed, the click runs. Someone who may not sync learns nothing about the cooldown.
    expect((await syncNow(payload, { req: await reqOf(staff), id: ids.now!, now: new Date(at.getTime() + 7 * 60_000) })).skipped).toBeUndefined()
    expect((await post(`/creators/${ids.now}/sync`, staffB)).status).toBe(404)
    expect((await post(`/creators/${ids.now}/sync`, curator)).status).toBe(403)
  })

  it('a site’s share of the day’s units: one site at its share stops cleanly, and another site still syncs', async () => {
    await rested(ids.now!)
    await post(`/creators/${ids.now}/sync`, staff)
    await raw('watchlist-usage').updateOne({}, { $set: { units: SITE_CAP, bySite: { s_A: SITE_CAP } } })
    await rested(ids.now!)
    yt.reset()
    const mine = await post(`/creators/${ids.now}/sync`, staff)
    expect(mine.status).toBe(200)
    expect(mine.body).toMatchObject({ stopped: 'site-cap', units: 0 })
    expect(mine.body.note).toContain('This site’s share of today’s units (20) is used')
    expect(yt.api()).toEqual([])
    expect((await usage())[0]).toMatchObject({ units: SITE_CAP, bySite: { s_A: SITE_CAP } })
    // Site B is under its own share and under the cap: it runs.
    yt.addChannel(channelId('share'), '@share')
    yt.upload(channelId('share'), { id: videoId('share1'), title: 'Made-up share' })
    const b = String((await payload.create({ collection: 'creators', data: { tenant: 'B', name: 'Made-up share', videosDefault: 'rules', channels: [{ handle: '@share' }] } as never })).id)
    const theirs = await post(`/creators/${b}/sync`, staffB)
    expect(theirs.body).toMatchObject({ added: 1, stopped: null })
    expect(theirs.body.units).toBeGreaterThan(0)
    expect((await usage())[0]!.bySite).toEqual({ s_A: SITE_CAP, s_B: theirs.body.units })
    // The cron goes on past a site that has used its share: site A's creators stop, site B's still sync.
    const later = new Date('2027-02-01T20:00:00Z')
    await raw('watchlist-usage').deleteMany({})
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(later)
    await raw('watchlist-usage').updateOne({ day }, { $set: { day, units: SITE_CAP, quotaStopped: false, bySite: { s_A: SITE_CAP }, digests: {} } }, { upsert: true })
    const cron = await syncDue(payload, { now: later })
    expect(cron.stopped).toBeNull()
    expect(cron.reports.filter((r) => r.site === 'A' && r.stopped === 'site-cap').length).toBeGreaterThan(0)
    expect(cron.reports.filter((r) => r.site === 'B' && !r.stopped && !r.skipped).length).toBeGreaterThan(0)
    expect(((await raw('watchlist-usage').findOne({ day }))!.bySite as Doc).s_A).toBe(SITE_CAP)
  })

  it('past the threshold, the curators hear at once after a Sync now', async () => {
    yt.addChannel(channelId('many'), '@many')
    for (let i = 0; i < 4; i++) yt.upload(channelId('many'), { id: videoId(`many${i}`), title: `Made-up many ${i}` })
    const c = String((await payload.create({ collection: 'creators', data: { tenant: 'B', name: 'Made-up many', videosDefault: 'picked', channels: [{ handle: '@many' }] } as never })).id)
    expect((await post(`/creators/${c}/sync`, staffB)).status).toBe(200)
    expect(notices).toEqual([expect.objectContaining({ kind: 'watchlist.review', site: 'B', urgent: true, waiting: 4 })])
    await payload.delete({ collection: 'videos', where: { creator: { equals: c } }, overrideAccess: true })
  })
})

describe('the review queue', () => {
  beforeAll(async () => {
    for (let i = 0; i < 3; i++) ids[`a${i}`] = await waiting('A', ids.pickedA!)
    ids.b0 = await waiting('B', ids.pickedB!)
    // Not waiting: decided, and hidden by a rule.
    await payload.create({ collection: 'videos', data: { tenant: 'A', creator: ids.pickedA, youtubeId: videoId('q-done'), title: 'Made-up decided', passedRules: true, source: 'api', choice: 'hide' } as never })
    await payload.create({ collection: 'videos', data: { tenant: 'A', creator: ids.pickedA, youtubeId: videoId('q-rule'), title: 'Made-up rule', passedRules: false, source: 'api' } as never })
  })

  it('refuses a signed-out visitor and a member, in words', async () => {
    expect(await reviewQueue({ payload, context: { site: 'A' } } as unknown as PayloadRequest)).toMatchObject({ error: { code: 'signIn' } })
    expect(await reviewQueue(await reqOf(member, 'A'))).toMatchObject({ error: { code: 'notStaff' } })
    expect(await reviewQueue(await reqOf({ ...curator, role: 'odd' } as never, 'A'))).toMatchObject({ error: { code: 'notStaff' } })
  })

  it('a curator sees their own site’s waiting videos, with why each waits; another site’s curator never sees them', async () => {
    const mine = (await reviewQueue(await reqOf(curator))) as Doc
    expect(mine.rows.map((r: Doc) => r.id).sort()).toEqual([ids.a0, ids.a1, ids.a2].sort())
    expect(mine.total).toBe(3)
    expect(Object.keys(mine.rows[0]).sort()).toEqual(['creator', 'description', 'duration', 'embeddable', 'id', 'kind', 'publishedAt', 'reason', 'thumbnail', 'title', 'youtubeId'])
    expect(mine.rows[0]).toMatchObject({ creator: 'Made-up picked A', reason: 'Made-up reason' })
    expect((await reviewQueue(await reqOf(staff))) as Doc).toMatchObject({ total: 3 })
    const theirs = (await reviewQueue(await reqOf(curatorB, 'A'))) as Doc
    expect(theirs.rows.map((r: Doc) => r.id)).toEqual([ids.b0])
    // Asking for a site that isn't theirs is refused, not answered with an empty list.
    expect(await reviewQueue(await reqOf(curatorB), { site: 'A' })).toMatchObject({ error: { code: 'notStaff' } })
    const all = (await reviewQueue(await reqOf(admin))) as Doc
    expect(all.total).toBe(4)
    expect(((await reviewQueue(await reqOf(admin), { site: 'B' })) as Doc).rows.map((r: Doc) => r.id)).toEqual([ids.b0])
  })

  it('the count for the dashboard: their sites for a curator, every site for an admin, 0 for everyone else', async () => {
    expect(await reviewQueueCount(payload, { req: await reqOf(curator) })).toBe(3)
    expect(await reviewQueueCount(payload, { req: await reqOf(staff) })).toBe(3)
    expect(await reviewQueueCount(payload, { req: await reqOf(curatorB) })).toBe(1)
    expect(await reviewQueueCount(payload, { req: await reqOf(admin) })).toBe(4)
    expect(await reviewQueueCount(payload, { req: await reqOf(admin), site: 'B' })).toBe(1)
    expect(await reviewQueueCount(payload, { req: await reqOf(member, 'A') })).toBe(0)
    expect(await reviewQueueCount(payload, { req: { payload, context: { site: 'A' } } as unknown as PayloadRequest })).toBe(0)
    expect(await reviewQueueCount(payload, { req: await reqOf(curatorB), site: 'A' })).toBe(0)
    expect(await reviewQueueCount(payload, { req: await reqOf({ ...curator, role: 'odd' } as never) })).toBe(0)
  })

  it('the review route: refusals leave the video undecided; a curator’s yes shows it; a second curator gets a 409', async () => {
    const path = `/videos/${ids.a0}/review`
    // Signed out gets the same answer here as on Sync now.
    const out = await post(path, null, { choice: 'show' })
    expect(out.status).toBe(401)
    expect(out.body).toEqual((await post(`/creators/${ids.now}/sync`, null)).body)
    expect((await post(path, member, { choice: 'show' })).status).toBeOneOf([403, 404])
    expect((await post(path, curatorB, { choice: 'show' })).status).toBeOneOf([403, 404])
    expect((await post(path, staffB, { choice: 'show' })).status).toBeOneOf([403, 404])
    expect((await post(path, curator, { choice: 'maybe' })).status).toBe(400)
    expect((await post(path, curator, undefined)).status).toBe(400)
    expect(await video(ids.a0!)).toMatchObject({ shown: false })
    expect((await video(ids.a0!)).choice ?? null).toBeNull()
    expect((await video(ids.a0!)).claim ?? null).toBeNull()
    const yes = await post(path, curator, { choice: 'show' })
    expect(yes.status).toBe(200)
    expect(yes.body).toEqual({ id: ids.a0, choice: 'show', shown: true })
    expect((await post(path, curator2, { choice: 'hide' })).status).toBe(409)
    expect(await video(ids.a0!)).toMatchObject({ shown: true, choice: 'show' })
    expect(await reviewQueueCount(payload, { req: await reqOf(curator) })).toBe(2)
    const no = await post(`/videos/${ids.a1}/review`, curator2, { choice: 'hide' })
    expect(no.body).toEqual({ id: ids.a1, choice: 'hide', shown: false })
  })
})

describe('the daily digest', () => {
  const day = (d: number) => new Date(`2026-12-0${d}T18:00:00Z`)
  it('a send that fails is tried again on the next run, and then only once that day', async () => {
    state.notifyFails = true
    const failed = await sendReviewDigest(payload, { mode: 'daily', sites: ['A'], now: day(1) })
    expect(failed[0]).toMatchObject({ sent: null, failed: true })
    state.notifyFails = false
    expect((await sendReviewDigest(payload, { mode: 'daily', sites: ['A'], now: day(1) }))[0]!.sent).toBe('daily')
    expect((await sendReviewDigest(payload, { mode: 'daily', sites: ['A'], now: day(1) }))[0]!.sent).toBeNull()
    expect(notices).toHaveLength(1)
  })

  it('nothing for an empty queue, and nothing while outside calls are off', async () => {
    expect((await sendReviewDigest(payload, { mode: 'daily', sites: ['C'], now: day(2) }))[0]).toMatchObject({ waiting: 0, sent: null })
    // At or under the threshold, nothing goes "at once".
    const few = (await sendReviewDigest(payload, { mode: 'urgent', sites: ['A'], now: day(2) }))[0]!
    expect(few.waiting).toBeGreaterThan(0)
    expect(few.waiting).toBeLessThanOrEqual(3)
    expect(few.sent).toBeNull()
    state.enabled = 1
    expect((await sendReviewDigest(payload, { mode: 'daily', sites: ['A'], now: day(2) }))[0]!.sent).toBeNull()
    expect(notices).toEqual([])
  })

  it('past the threshold it goes at once, and the daily one stands down that day; the next day it goes again', async () => {
    for (let i = 0; i < 4; i++) await waiting('A', ids.pickedA!)
    expect((await sendReviewDigest(payload, { mode: 'urgent', sites: ['A'], now: day(3) }))[0]!.sent).toBe('urgent')
    expect((await sendReviewDigest(payload, { mode: 'urgent', sites: ['A'], now: day(3) }))[0]!.sent).toBeNull()
    expect((await sendReviewDigest(payload, { mode: 'daily', sites: ['A'], now: day(3) }))[0]!.sent).toBeNull()
    expect((await sendReviewDigest(payload, { mode: 'daily', sites: ['A'], now: day(4) }))[0]!.sent).toBe('daily')
    // A jump after the day's digest still goes out at once.
    expect((await sendReviewDigest(payload, { mode: 'urgent', sites: ['A'], now: day(4) }))[0]!.sent).toBe('urgent')
    expect(notices.map((n) => (n.kind === 'watchlist.review' ? n.urgent : null))).toEqual([true, false, true])
  })
})

describe('the gone-videos sweep', () => {
  const NOW = new Date('2026-11-11T12:00:00Z')
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
  async function gone(key: string, days: number, extra: Doc = {}) {
    const id = String(
      (
        await payload.create({
          collection: 'videos',
          data: { tenant: 'A', creator: ids.pickedA, youtubeId: videoId(key), title: `Made-up ${key}`, description: 'Made-up words', thumbnail: `https://i.ytimg.com/vi/${videoId(key)}/hq.jpg`, duration: 300, playlists: ['PLmadeup'], kind: 'care', source: 'api', passedRules: true, unavailable: true, unavailableSince: daysAgo(days), ...extra } as never,
        })
      ).id,
    )
    return id
  }
  beforeAll(async () => {
    yt.addChannel(channelId('back'), '@back')
    yt.upload(channelId('back'), { id: videoId('g-back'), title: 'Made-up back' })
    ids.gGone = await gone('g-gone', 40, { choice: 'show', species: [topicIds.one], speciesState: 'approved' })
    ids.gBack = await gone('g-back', 40)
    ids.gRecent = await gone('g-recent', 5)
  })

  it('clears nothing without YouTube’s answer: no key, outside calls off, or the cap reached', async () => {
    state.key = null
    expect(await sweepGoneVideos(payload, { now: NOW })).toMatchObject({ skipped: 'no-key', cleared: 0 })
    state.key = KEY
    state.enabled = 'yes'
    expect(await sweepGoneVideos(payload, { now: NOW })).toMatchObject({ skipped: 'disabled', cleared: 0 })
    state.enabled = true
    await sweepGoneVideos(payload, { now: new Date('2020-01-01T00:00:00Z') }) // makes today's ledger row; nothing is that old
    await raw('watchlist-usage').updateOne({}, { $set: { units: CAP, day: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(NOW) } }, { upsert: true })
    expect(await sweepGoneVideos(payload, { now: NOW })).toMatchObject({ stopped: 'cap', cleared: 0, units: 0, checked: 0 })
    // The site's own share used up: its videos are left for the next run.
    await raw('watchlist-usage').updateOne({}, { $set: { units: SITE_CAP, bySite: { s_A: SITE_CAP } } })
    expect(await sweepGoneVideos(payload, { now: NOW })).toMatchObject({ stopped: 'site-cap', cleared: 0, units: 0, checked: 0 })
    yt.failNext.push({ status: 500, reason: 'backendError' })
    await clearUsage()
    expect(await sweepGoneVideos(payload, { now: NOW })).toMatchObject({ stopped: 'error', cleared: 0 })
    expect(yt.api().length).toBe(1)
    for (const id of [ids.gGone, ids.gBack, ids.gRecent]) expect(await video(id!)).toMatchObject({ unavailable: true, description: 'Made-up words' })
  })

  it('a quota error stops the day for everyone', async () => {
    yt.failNext.push({ status: 403, reason: 'quotaExceeded' })
    expect(await sweepGoneVideos(payload, { now: NOW })).toMatchObject({ stopped: 'quota', cleared: 0 })
    expect((await usage())[0]!.quotaStopped).toBe(true)
    expect(await sweepGoneVideos(payload, { now: NOW })).toMatchObject({ stopped: 'quota', units: 0 })
  })

  it('clears YouTube’s details of videos still gone after the grace period, keeps our own notes, and marks returned ones back', async () => {
    const r = await sweepGoneVideos(payload, { now: NOW })
    expect(r).toMatchObject({ mode: 'clear', checked: 2, cleared: 1, returned: 1, units: 1 })
    expect(r.stopped).toBeUndefined()
    expect((await usage())[0]).toMatchObject({ units: 1, bySite: { s_A: 1 } })
    const g = await video(ids.gGone!)
    expect(g).toMatchObject({ title: GONE_TITLE, youtubeId: videoId('g-gone'), choice: 'show', kind: 'care', species: [topicIds.one], speciesState: 'approved', unavailable: true, shown: false, playlists: [] })
    expect(g.description ?? null).toBeNull()
    expect(g.thumbnail ?? null).toBeNull()
    expect(g.duration ?? null).toBeNull()
    expect(await video(ids.gBack!)).toMatchObject({ unavailable: false, title: 'Made-up g-back', description: 'Made-up words' })
    expect(await video(ids.gRecent!)).toMatchObject({ unavailable: true, title: 'Made-up g-recent', description: 'Made-up words' })
    // Nothing left to do: no call, no units.
    yt.reset()
    expect(await sweepGoneVideos(payload, { now: NOW })).toMatchObject({ checked: 0, cleared: 0, units: 0 })
    expect(yt.calls).toEqual([])
    expect(networkCalls).toEqual([])
  })

  it('a site that has used its share is left for the next run, and the other sites are still swept', async () => {
    const mine = await gone('g-share-a', 60)
    const theirs = String((await payload.create({ collection: 'videos', data: { tenant: 'B', creator: ids.pickedB, youtubeId: videoId('g-share-b'), title: 'Made-up g-share-b', description: 'Made-up words', source: 'api', unavailable: true, unavailableSince: daysAgo(45) } as never })).id)
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(NOW)
    await raw('watchlist-usage').updateOne({ day }, { $set: { day, units: SITE_CAP, quotaStopped: false, bySite: { s_A: SITE_CAP }, digests: {} } }, { upsert: true })
    const r = await sweepGoneVideos(payload, { now: NOW })
    expect(r).toMatchObject({ stopped: 'site-cap', checked: 1, cleared: 1, units: 1 })
    expect(await video(mine)).toMatchObject({ title: 'Made-up g-share-a', description: 'Made-up words' })
    expect(await video(theirs)).toMatchObject({ title: GONE_TITLE })
    expect((await raw('watchlist-usage').findOne({ day }))!.bySite).toEqual({ s_A: SITE_CAP, s_B: 1 })
  })

  it('with the default, `keep`, the sweep does nothing at all', async () => {
    const k = await startPayload(options('keep') as never, TAXA)
    try {
      const c = String((await k.payload.create({ collection: 'creators', data: { tenant: 'A', name: 'Made-up keep', channels: [{ handle: '@keep' }] } as never })).id)
      const v = String((await k.payload.create({ collection: 'videos', data: { tenant: 'A', creator: c, youtubeId: videoId('keep'), title: 'Made-up kept', description: 'Made-up words', source: 'api', unavailable: true, unavailableSince: daysAgo(400) } as never })).id)
      yt.reset()
      expect(await sweepGoneVideos(k.payload, { now: NOW })).toEqual({ mode: 'keep', skipped: 'keep', checked: 0, cleared: 0, returned: 0, units: 0 })
      expect(yt.calls).toEqual([])
      expect(await k.payload.findByID({ collection: 'videos', id: v, overrideAccess: true })).toMatchObject({ title: 'Made-up kept', description: 'Made-up words' })
    } finally {
      await k.payload.destroy()
    }
  })
})

describe('the cron', () => {
  it('past the threshold, the curators hear at once after the hourly run too', async () => {
    const later = new Date('2027-03-01T20:00:00Z')
    yt.addChannel(channelId('cron'), '@cron')
    for (let i = 0; i < 4; i++) yt.upload(channelId('cron'), { id: videoId(`cron${i}`), title: `Made-up cron ${i}` })
    await payload.create({ collection: 'creators', data: { tenant: 'B', name: 'Made-up cron', videosDefault: 'picked', channels: [{ handle: '@cron' }] } as never })
    const r = await syncDue(payload, { now: later })
    expect(r.synced).toBeGreaterThan(0)
    expect(notices.filter((n) => n.kind === 'watchlist.review')).toEqual([expect.objectContaining({ site: 'B', urgent: true })])
    // Once a day: the next hour's run adds nothing new and says nothing more.
    notices.length = 0
    await syncDue(payload, { now: new Date(later.getTime() + 3600_000) })
    expect(notices.filter((n) => n.kind === 'watchlist.review')).toEqual([])
  })
})
