import type { Payload, PayloadRequest } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { countWaiting } from '../src/curation.js'
import { AlreadyDecided, reviewQueueCount, reviewVideo, sendReviewDigest, syncCreator, type WatchlistNotice } from '../src/index.js'
import { fakeYoutube } from './fakeYoutube.js'
import { channelId, person, startPayload, stopMongo, videoId, type Person } from './harness.js'

// Curation: a curator's yes with an atomic claim, the review queue, the daily digest through `notify`, and sync
// problems told to editors. Made-up people and videos on made-up sites A and B.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
let payload: Payload
let curator1: Person, curator2: Person, member: Person, curatorB: Person
const notices: WatchlistNotice[] = []
let enabled: unknown = true
let pickedId = ''
const yt = fakeYoutube()
const reqOf = (p: Person) => ({ user: p, payload, context: {} }) as unknown as PayloadRequest

async function waitingVideo(key: string, site = 'A', creator = pickedId) {
  return String((await payload.create({ collection: 'videos', data: { tenant: site, creator, youtubeId: videoId(key), title: `Made-up ${key}`, passedRules: true, source: 'api' } as never })).id)
}

beforeAll(async () => {
  const h = await startPayload((o) => ({ ...o, enabled: () => enabled as boolean, notify: async (n) => void notices.push(n), curation: { urgentAt: 3 }, youtube: { apiKey: () => 'made-up-key', fetch: (...a) => yt.fetch(...a), sleep: async () => {} } }))
  payload = h.payload
  curator1 = await person(payload, 'A', 'curator')
  curator2 = await person(payload, 'A', 'curator')
  curatorB = await person(payload, 'B', 'curator')
  member = await person(payload, 'A')
  pickedId = String((await payload.create({ collection: 'creators', data: { tenant: 'A', name: 'Made-up picked', videosDefault: 'picked', channels: [{ handle: '@p' }] } as never })).id)
})
afterAll(async () => {
  await payload.destroy()
  await stopMongo()
})
beforeEach(() => {
  notices.length = 0
  enabled = true
})

describe('a curator’s yes', () => {
  it('two curators at once: exactly one decides, the other is told someone already did', async () => {
    const id = await waitingVideo('race')
    const results = await Promise.allSettled([reviewVideo(payload, { req: reqOf(curator1), id, choice: 'show' }), reviewVideo(payload, { req: reqOf(curator2), id, choice: 'hide' })])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(lost.reason).toBeInstanceOf(AlreadyDecided)
    const doc = (await payload.findByID({ collection: 'videos', id, overrideAccess: true })) as unknown as Doc
    const won = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ choice: string }>).value
    expect(doc.choice).toBe(won.choice)
    expect(doc.shown).toBe(won.choice === 'show')
  })

  it('a decided video can’t be claimed again from the queue; clearing the choice frees it', async () => {
    const id = await waitingVideo('again')
    await reviewVideo(payload, { req: reqOf(curator1), id, choice: 'hide' })
    await expect(reviewVideo(payload, { req: reqOf(curator2), id, choice: 'show' })).rejects.toBeInstanceOf(AlreadyDecided)
    await payload.update({ collection: 'videos', id, data: { choice: null } as never, overrideAccess: true })
    expect((await reviewVideo(payload, { req: reqOf(curator2), id, choice: 'show' })).shown).toBe(true)
  })

  it('a member, a signed-out visitor and another site’s curator can’t decide, and leave no claim', async () => {
    const id = await waitingVideo('refused')
    await expect(reviewVideo(payload, { req: reqOf(member), id, choice: 'show' })).rejects.toThrow()
    await expect(reviewVideo(payload, { req: reqOf(curatorB), id, choice: 'show' })).rejects.toThrow()
    await expect(reviewVideo(payload, { req: { payload, context: {} } as unknown as PayloadRequest, id, choice: 'show' })).rejects.toThrow()
    await expect(reviewVideo(payload, { req: reqOf(curator1), id, choice: 'maybe' as never })).rejects.toThrow(/show.*hide/)
    const doc = (await payload.findByID({ collection: 'videos', id, overrideAccess: true })) as unknown as Doc
    expect(doc.claim ?? null).toBeNull()
    expect(doc.choice ?? null).toBeNull()
  })
})

describe('the review queue and the digest', () => {
  it('counts what waits: picked-creator videos that passed, and feed-only ones; not decided, gone, unlisted or rule-hidden ones', async () => {
    const before = await countWaiting(payload, 'A')
    await waitingVideo('q-wait')
    await payload.create({ collection: 'videos', data: { tenant: 'A', creator: pickedId, youtubeId: videoId('q-rss'), title: 'Made-up feed', source: 'rss', passedRules: false } as never })
    await payload.create({ collection: 'videos', data: { tenant: 'A', creator: pickedId, youtubeId: videoId('q-hid'), title: 'Made-up hidden', source: 'api', passedRules: false } as never })
    await payload.create({ collection: 'videos', data: { tenant: 'A', creator: pickedId, youtubeId: videoId('q-gone'), title: 'Made-up gone', source: 'api', passedRules: true, unavailable: true } as never })
    await payload.create({ collection: 'videos', data: { tenant: 'A', creator: pickedId, youtubeId: videoId('q-done'), title: 'Made-up done', source: 'api', passedRules: true, choice: 'hide' } as never })
    expect(await countWaiting(payload, 'A')).toBe(before + 2)
    expect(await countWaiting(payload, 'B')).toBe(0)
  })

  it('one daily digest per site when videos wait, none for an empty queue, and once a day only', async () => {
    const r = await sendReviewDigest(payload, { mode: 'daily', sites: ['A', 'B'] })
    expect(r.find((x) => x.site === 'A')!.sent).toBe('daily')
    expect(r.find((x) => x.site === 'B')).toMatchObject({ waiting: 0, sent: null })
    expect(notices).toEqual([expect.objectContaining({ kind: 'watchlist.review', site: 'A', urgent: false })])
    const again = await sendReviewDigest(payload, { mode: 'daily', sites: ['A'] })
    expect(again[0]!.sent).toBeNull()
    expect(notices).toHaveLength(1)
  })

  it('past the threshold, one urgent digest at once; and nothing at all while outside calls are off', async () => {
    enabled = 'true'
    for (let i = 0; i < 4; i++) await waitingVideo(`u${i}`)
    expect((await sendReviewDigest(payload, { mode: 'urgent', sites: ['A'] }))[0]!.sent).toBeNull()
    expect(notices).toEqual([])
    enabled = true
    expect((await sendReviewDigest(payload, { mode: 'urgent', sites: ['A'] }))[0]!.sent).toBe('urgent')
    expect((await sendReviewDigest(payload, { mode: 'urgent', sites: ['A'] }))[0]!.sent).toBeNull()
    expect(notices.filter((n) => n.kind === 'watchlist.review' && n.urgent)).toHaveLength(1)
  })

  it('a sync problem is told to the site, without the key', async () => {
    const ch = channelId('problem')
    yt.addChannel(ch, '@problem')
    yt.upload(ch, { id: videoId('pr1'), title: 'Made-up' })
    yt.feedState.broken = true
    yt.failNext.push({ status: 403, reason: 'quotaExceeded' })
    const c = (await payload.create({ collection: 'creators', data: { tenant: 'A', name: 'Made-up problem', channels: [{ handle: '@problem' }] } as never })) as unknown as Doc
    await syncCreator(payload, c.id)
    expect(notices).toEqual([expect.objectContaining({ kind: 'watchlist.sync-problem', site: 'A', problem: 'quota' })])
    expect(JSON.stringify(notices)).not.toContain('made-up-key')
  })
})
