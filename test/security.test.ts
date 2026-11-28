import type { Payload, PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AlreadyDecided, reviewVideo, syncCreator } from '../src/index.js'
import { fakeYoutube } from './fakeYoutube.js'
import { as, channelId, person, startPayload, stopMongo, tokenOf, videoId, type Harness, type Person } from './harness.js'

// The security read of 5177185 (2026-11-11): internal fields stay with the record's own curators and editors, records
// can't point across sites, a decided video's claim holds against plain edits, and the smaller fixes. Made-up data.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
let h: Harness
let payload: Payload
let member: Person, curator: Person, curator2: Person, staff: Person, staffB: Person, curatorB: Person, admin: Person
const ids: Record<string, string> = {}
const tokens: Record<string, string> = {}
const yt = fakeYoutube()

export const PUBLIC_VIDEO_FIELDS = ['id', 'title', 'youtubeId', 'creator', 'publishedAt', 'shown', 'kind', 'choice', 'description', 'duration', 'thumbnail', 'playlists', 'unavailable', 'embeddable', 'madeForKids', 'tenant', 'createdAt', 'updatedAt']
export const INTERNAL_VIDEO_FIELDS = ['hiddenReason', 'ruleKey', 'locked', 'source', 'channelId', 'curation', 'passedRules', 'unavailableSince', 'claim']
export const PUBLIC_CREATOR_FIELDS = ['id', 'name', 'slug', 'generateSlug', 'listed', 'website', 'bio', 'avatar', 'showsDisplay', 'shows', 'channels', 'videosDefault', 'tenant', '_order', 'createdAt', 'updatedAt']
export const INTERNAL_CREATOR_FIELDS = ['doNotFeature', 'doNotFeatureNote', 'syncDays', 'syncHour', 'lastSyncedAt', 'lastRecheckAt', 'lastFullSyncAt', 'syncingSince', 'syncNote']
export const INTERNAL_CHANNEL_FIELDS = ['excludeKeywords', 'minMinutes', 'uploads', 'backfillToken', 'backfillDone', 'rssSeen']

const restAs = (p: Person | null) => ({ token: p ? tokens[p.id] : undefined, site: p ? undefined : 'A' })
// Payload answers a withheld array field with [] (its rows withheld), so an empty array isn't a leak.
const leaks = (doc: Doc, internal: string[]) => internal.filter((f) => doc[f] !== undefined && !(Array.isArray(doc[f]) && doc[f].length === 0))
function creatorLeaks(c: Doc): string[] {
  return [...leaks(c, INTERNAL_CREATOR_FIELDS), ...((c.channels ?? []) as Doc[]).flatMap((ch) => leaks(ch, INTERNAL_CHANNEL_FIELDS).map((f) => `channels.${f}`))]
}

beforeAll(async () => {
  h = await startPayload((o) => ({ ...o, youtube: { apiKey: () => 'made-up-key', fetch: (...a) => yt.fetch(...a), sleep: async () => {}, dailyUnitCap: 100 } }))
  payload = h.payload
  member = await person(payload, 'A')
  curator = await person(payload, 'A', 'curator')
  curator2 = await person(payload, 'A', 'curator')
  curatorB = await person(payload, 'B', 'curator')
  staff = await person(payload, 'A', 'staff')
  staffB = await person(payload, 'B', 'staff')
  admin = await person(payload, 'A', 'admin')
  for (const p of [member, curator, curator2, curatorB, staff, staffB, admin]) tokens[p.id] = await tokenOf(payload, p)
  const channel = { handle: '@made-up', speciesMode: 'review', excludeKeywords: 'made-up-secret-keyword', minMinutes: 2, uploads: 'UUmadeup', backfillToken: 'made-up-token', backfillDone: true, rssSeen: videoId('seen'), playlists: [{ playlist: 'PLmadeup', rule: 'exclude' }] }
  ids.rules = String((await payload.create({ collection: 'creators', data: { tenant: 'A', name: 'Made-up rules', videosDefault: 'rules', syncNote: 'Made-up error text', doNotFeatureNote: 'Made-up contact note', lastSyncedAt: '2026-11-01T00:00:00Z', channels: [channel] } as never })).id)
  ids.siteB = String((await payload.create({ collection: 'creators', data: { tenant: 'B', name: 'Made-up B', videosDefault: 'rules', channels: [{ handle: '@b' }] } as never })).id)
  ids.shown = String((await payload.create({ collection: 'videos', data: { tenant: 'A', creator: ids.rules, youtubeId: videoId('shown'), title: 'Made-up shown', passedRules: true, source: 'api', ruleKey: 'made-up', channelId: channelId('x') } as never })).id)
  await payload.db.collections.videos!.updateOne({ _id: ids.shown! }, { $set: { claim: `${curator.id}:made-up`, hiddenReason: 'Made-up reason' } })
})
afterAll(async () => {
  await payload.destroy()
  await stopMongo()
})

describe('B1: internal fields', () => {
  for (const who of ['visitor', 'member'] as const)
    for (const depth of [0, 1]) {
      it(`REST, ${who}, depth ${depth}: no internal video or creator field`, async () => {
        const p = who === 'member' ? member : null
        const r = await h.rest(`/videos?depth=${depth}&limit=50`, restAs(p))
        expect(r.status).toBe(200)
        expect(r.body.docs.length).toBeGreaterThan(0)
        for (const d of r.body.docs as Doc[]) {
          expect(leaks(d, INTERNAL_VIDEO_FIELDS)).toEqual([])
          if (depth === 1) expect(creatorLeaks(d.creator)).toEqual([])
        }
        const one = await h.rest(`/videos/${ids.shown}?depth=${depth}`, restAs(p))
        expect(leaks(one.body, INTERNAL_VIDEO_FIELDS)).toEqual([])
        const c = await h.rest(`/creators/${ids.rules}?depth=${depth}`, restAs(p))
        expect(c.status).toBe(200)
        expect(creatorLeaks(c.body)).toEqual([])
      })
      it(`Local API, ${who}, depth ${depth}: no internal video or creator field`, async () => {
        const p = who === 'member' ? member : null
        const { docs } = await payload.find({ collection: 'videos', depth, ...as(p, 'A') })
        for (const d of docs as Doc[]) {
          expect(leaks(d, INTERNAL_VIDEO_FIELDS)).toEqual([])
          if (depth === 1) expect(creatorLeaks(d.creator)).toEqual([])
        }
        expect(creatorLeaks((await payload.findByID({ collection: 'creators', id: ids.rules!, depth, ...as(p, 'A') })) as Doc)).toEqual([])
      })
    }

  const refusedQueries = [
    `/videos?where[claim][exists]=true`,
    `/videos?where[claim][like]=${'x'}`,
    `/videos?where[or][0][hiddenReason][exists]=true&where[or][1][title][exists]=true`,
    `/videos?where[and][0][or][0][curation][equals]=rules`,
    `/videos?where[passedRules][equals]=true`,
    `/videos?where[creator.syncNote][exists]=true`,
    `/videos?where[creator.doNotFeatureNote][like]=contact`,
    `/videos?sort=claim`,
    `/videos?sort=-hiddenReason`,
    `/creators?where[syncNote][like]=error`,
    `/creators?where[channels.backfillToken][exists]=true`,
    `/creators?where[or][0][doNotFeatureNote][exists]=true`,
    `/creators?sort=-lastSyncedAt`,
  ]
  for (const who of ['visitor', 'member'] as const)
    for (const q of refusedQueries)
      it(`REST, ${who}: refuses ${q}`, async () => {
        const r = await h.rest(q, restAs(who === 'member' ? member : null))
        expect(r.status).toBeOneOf([400, 403])
      })

  it('Local API refuses a filter or sort on internal fields for a visitor', async () => {
    await expect(payload.find({ collection: 'videos', where: { claim: { exists: true } }, ...as(null, 'A') })).rejects.toThrow()
    await expect(payload.find({ collection: 'videos', where: { or: [{ title: { exists: true } }, { and: [{ hiddenReason: { exists: true } }] }] }, ...as(member) })).rejects.toThrow()
    await expect(payload.find({ collection: 'videos', sort: 'curation', ...as(null, 'A') })).rejects.toThrow()
    await expect(payload.count({ collection: 'videos', where: { claim: { exists: true } }, ...as(null, 'A') })).rejects.toThrow()
  })

  it('public filters still work', async () => {
    const r = await h.rest(`/videos?where[kind][exists]=false&where[title][like]=Made-up&sort=-publishedAt`, restAs(null))
    expect(r.status).toBe(200)
  })

  it('a curator and staff of the site see the internal fields; another site’s curator doesn’t', async () => {
    for (const p of [curator, staff, admin]) {
      const r = await h.rest(`/videos/${ids.shown}?depth=0`, restAs(p))
      expect(r.body.claim).toContain(curator.id)
      expect(r.body.hiddenReason).toBe('Made-up reason')
    }
    expect((await h.rest(`/creators/${ids.rules}`, restAs(staff))).body.syncNote).toBe('Made-up error text')
    const b = await h.rest(`/videos/${ids.shown}?depth=1`, { token: tokens[curatorB.id], site: 'A' })
    expect(b.status).toBe(200)
    expect(leaks(b.body, INTERNAL_VIDEO_FIELDS)).toEqual([])
    expect(creatorLeaks(b.body.creator)).toEqual([])
    // Another site's staff can't use internal filters to learn about this site's records either.
    const q = await h.rest(`/videos?where[claim][like]=${curator.id}`, { token: tokens[staffB.id], site: 'A' })
    expect(q.status === 200 ? q.body.docs.length : 0).toBe(0)
    const sorted = await h.rest(`/videos?sort=claim&limit=100`, { token: tokens[staffB.id], site: 'A' })
    expect(sorted.status === 200 ? (sorted.body.docs as Doc[]).filter((d) => d.tenant === 'A').length : 0).toBe(0)
  })
})

describe('S1: no record points across sites', () => {
  it('refuses a site-A video pointing at a site-B creator, for staff and for a system write', async () => {
    const r = await h.rest('/videos', { method: 'POST', token: tokens[staff.id], body: { tenant: 'A', creator: ids.siteB, youtubeId: videoId('cross1'), title: 'Made-up cross' } })
    expect(r.status).toBeOneOf([400, 403])
    await expect(payload.create({ collection: 'videos', data: { tenant: 'A', creator: ids.siteB, youtubeId: videoId('cross2'), title: 'Made-up cross', passedRules: true, source: 'api' } as never })).rejects.toThrow()
    expect((await h.rest(`/videos/${ids.shown}`, { method: 'PATCH', token: tokens[staff.id], body: { creator: ids.siteB } })).status).toBeOneOf([400, 403])
  })

  it('a stored cross-site video never shows publicly, and a mode change re-judges only the creator’s own site', async () => {
    const native = payload.db.collections.videos!
    const created = await payload.create({ collection: 'videos', data: { tenant: 'B', creator: ids.siteB, youtubeId: videoId('cross3'), title: 'Made-up cross three', passedRules: true, source: 'api' } as never })
    // Written outside Payload's hooks: a site-A record pointing at site B's creator.
    await native.updateOne({ _id: created.id }, { $set: { tenant: 'A' } })
    const seen = (await payload.find({ collection: 'videos', ...as(null, 'A'), pagination: false })).docs.map((d) => String(d.id))
    expect(seen).not.toContain(String(created.id))
    await payload.update({ collection: 'creators', id: ids.siteB!, data: { videosDefault: 'picked' } as never, overrideAccess: true })
    const raw = (await native.findOne({ _id: created.id }).lean()) as Doc
    expect(raw.curation).toBe('rules')
    await payload.update({ collection: 'creators', id: ids.siteB!, data: { videosDefault: 'rules' } as never, overrideAccess: true })
  })
})

describe('S2: a claim holds against plain edits', () => {
  it('a second curator’s REST PATCH can’t change a video another curator decided', async () => {
    const id = String((await payload.create({ collection: 'videos', data: { tenant: 'A', creator: ids.rules, youtubeId: videoId('claimed'), title: 'Made-up claimed', passedRules: true, source: 'api' } as never })).id)
    const req = { user: curator, payload, context: {} } as unknown as PayloadRequest
    await reviewVideo(payload, { req, id, choice: 'hide' })
    expect((await h.rest(`/videos/${id}`, { method: 'PATCH', token: tokens[curator2.id], body: { choice: 'show' } })).status).toBe(409)
    expect((await h.rest(`/videos/${id}`, { method: 'PATCH', token: tokens[curator2.id], body: { shown: true } })).status).toBe(409)
    // The curator who decided, and the site's staff, can still change it.
    expect((await h.rest(`/videos/${id}`, { method: 'PATCH', token: tokens[curator.id], body: { choice: 'show' } })).status).toBe(200)
    expect((await h.rest(`/videos/${id}`, { method: 'PATCH', token: tokens[staff.id], body: { choice: 'hide' } })).status).toBe(200)
  })

  it('people never write the claim themselves, staff included', async () => {
    const id = String((await payload.create({ collection: 'videos', data: { tenant: 'A', creator: ids.rules!, youtubeId: videoId('noclaim'), title: 'Made-up', passedRules: true, source: 'api' } as never })).id)
    expect((await h.rest(`/videos/${id}`, { method: 'PATCH', token: tokens[staff.id], body: { claim: `${curator2.id}:forged`, title: 'Made-up two' } })).status).toBe(200)
    const raw = (await payload.db.collections.videos!.findOne({ _id: id }).lean()) as Doc
    expect(raw.claim ?? null).toBeNull()
  })

  it('a plain PATCH on an undecided video takes the claim, so two curators can’t both decide', async () => {
    const id = String((await payload.create({ collection: 'videos', data: { tenant: 'A', creator: ids.rules, youtubeId: videoId('patchrace'), title: 'Made-up race', passedRules: true, source: 'api' } as never })).id)
    const [a, b] = await Promise.all([
      h.rest(`/videos/${id}`, { method: 'PATCH', token: tokens[curator.id], body: { choice: 'show' } }),
      h.rest(`/videos/${id}`, { method: 'PATCH', token: tokens[curator2.id], body: { choice: 'hide' } }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const req = { user: curator2, payload, context: {} } as unknown as PayloadRequest
    const loser = a.status === 409 ? curator : curator2
    await expect(reviewVideo(payload, { req: { ...req, user: loser } as never, id, choice: 'show' })).rejects.toBeInstanceOf(AlreadyDecided)
  })
})

describe('nits', () => {
  it('the unit ledger shows an editor only their own sites’ units', async () => {
    await payload.db.collections['playlists-usage']!.collection.updateOne({ day: '2026-01-01' }, { $set: { day: '2026-01-01', units: 9, quotaStopped: false, bySite: { s_A: 4, s_B: 5 }, digests: { s_B: { daily: new Date() } } } }, { upsert: true })
    const r = await h.rest('/playlists-usage?where[day][equals]=2026-01-01', { token: tokens[staff.id] })
    expect(r.status).toBe(200)
    const doc = r.body.docs[0] as Doc
    expect(doc.units).toBeUndefined()
    expect(doc.digests).toBeUndefined()
    expect(doc.bySite).toEqual({ s_A: 4 })
    expect((await h.rest('/playlists-usage?where[units][greater_than]=1', { token: tokens[staff.id] })).status).toBeOneOf([400, 403])
    expect((await h.rest('/playlists-usage?where[day][equals]=2026-01-01', { token: tokens[admin.id] })).body.docs[0].units).toBe(9)
  })

  it('a creator’s website takes http and https links only', async () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://example.test', 'not a link'])
      await expect(payload.update({ collection: 'creators', id: ids.rules!, data: { website: bad } as never, overrideAccess: true })).rejects.toThrow()
    await payload.update({ collection: 'creators', id: ids.rules!, data: { website: 'https://example.test/made-up' } as never, overrideAccess: true })
    await payload.update({ collection: 'creators', id: ids.rules!, data: { website: '' } as never, overrideAccess: true })
  })

  it('a quota stop seen by a run already going is reported as quota, not cap', async () => {
    const ch = channelId('concurrent')
    yt.addChannel(ch, '@concurrent')
    yt.upload(ch, { id: videoId('cc1'), title: 'Made-up care' })
    const c = (await payload.create({ collection: 'creators', data: { tenant: 'A', name: 'Made-up concurrent', videosDefault: 'rules', channels: [{ handle: '@concurrent' }] } as never })) as unknown as Doc
    const { ledger } = await import('../src/ledger.js')
    const { optionsOf } = await import('../src/index.js')
    const book = ledger(payload, optionsOf(payload), () => new Date())
    // Another run stops the day right after this run has read the ledger.
    const realFetch = yt.fetch
    let stopped = false
    const o = optionsOf(payload)
    const before = o.youtube!.fetch
    o.youtube!.fetch = (async (...a: Parameters<typeof fetch>) => {
      if (!stopped && String(a[0]).includes('googleapis')) {
        stopped = true
        await book.stopForQuota()
      }
      return realFetch(...a)
    }) as typeof fetch
    yt.feedState.broken = true
    try {
      const r = await syncCreator(payload, c.id)
      expect(r.stopped).toBe('quota')
    } finally {
      o.youtube!.fetch = before
      yt.feedState.broken = false
    }
  })
})
