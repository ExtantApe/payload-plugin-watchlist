import type { Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { GONE_TITLE, syncCreator, syncDue, type ClassifyHook, type PlaylistsOptions } from '../src/index.js'
import { fakeYoutube, type FakeYoutube } from './fakeYoutube.js'
import { channelId, startPayload, stopMongo, videoId } from './harness.js'
import { networkCalls } from './setup.js'

// The sync on a made-up YouTube: RSS first, the Data API only when needed, the per-channel rules, the unit ledger, and
// the gates (no key from env, nothing at all unless `enabled` is exactly true). Made-up channels and videos only.

const KEY = 'made-up-api-key-123456'
const classifyCalls: { title: string; description: string; channel: string; key: string }[][] = []
const classify: ClassifyHook = async (videos) => {
  classifyCalls.push(videos.map((v) => ({ ...v })))
  const out = new Map()
  for (const v of videos) {
    if (/garbled/i.test(v.title)) out.set(v.key, { kind: 'nonsense' })
    else if (/cat/i.test(v.title)) out.set(v.key, { kind: 'care', relevant: false })
    else if (/vlog/i.test(v.title)) out.set(v.key, { kind: 'vlog' })
    else if (/unclassified/i.test(v.title)) continue
    else out.set(v.key, { kind: 'care' })
  }
  return out
}

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
let yt: FakeYoutube
let state: { key: string | null; enabled: unknown; sleeps: number[] }
let payload: Payload

async function start(change: (o: PlaylistsOptions) => PlaylistsOptions = (o) => o) {
  const h = await startPayload((o) =>
    change({
      ...o,
      enabled: () => state.enabled as boolean,
      classify,
      youtube: { apiKey: () => state.key, fetch: (...a) => yt.fetch(...a), sleep: async (ms) => void state.sleeps.push(ms), dailyUnitCap: 50 },
    }),
  )
  return h.payload
}

const CH = channelId('rules')
async function creator(data: Doc = {}) {
  return (await payload.create({ collection: 'creators', data: { tenant: 'A', name: `Made-up ${Math.random()}`, videosDefault: 'rules', channels: [{ handle: '@madeup' }], ...data } as never })) as unknown as Doc
}
const videosOf = async (creatorId: string) =>
  (await payload.find({ collection: 'videos', where: { creator: { equals: creatorId } }, pagination: false, depth: 0, overrideAccess: true })).docs as unknown as Doc[]
const byYt = (docs: Doc[]) => new Map(docs.map((d) => [d.youtubeId, d]))
const usage = async () => (await payload.find({ collection: 'playlists-usage', overrideAccess: true, pagination: false })).docs as unknown as Doc[]
const clearUsage = () => payload.delete({ collection: 'playlists-usage', where: { id: { exists: true } }, overrideAccess: true })

beforeAll(async () => {
  state = { key: KEY, enabled: true, sleeps: [] }
  yt = fakeYoutube()
  payload = await start()
})
afterAll(async () => {
  await payload.destroy()
  await stopMongo()
})
beforeEach(async () => {
  state = { key: KEY, enabled: true, sleeps: [] }
  yt.reset()
  yt.failNext.length = 0
  yt.feedState.broken = false
  classifyCalls.length = 0
  await clearUsage()
})

describe('the rules, through a first sync', () => {
  it('applies each rule in order and shows only what passes the rules and the classifier, under a rules creator', async () => {
    yt.addChannel(CH, '@madeup')
    yt.playlist('PLexcluded', 'Made-up excluded', [videoId('excl')])
    const vids = [
      { id: videoId('good'), title: 'Made-up care guide' },
      { id: videoId('live'), title: 'Made-up stream', live: true },
      { id: videoId('short'), title: 'Made-up clip', seconds: 40 },
      { id: videoId('shorts3'), title: 'Made-up #shorts', seconds: 150 },
      { id: videoId('vert'), title: 'Made-up tall', vertical: true },
      { id: videoId('reply'), title: 'Replying to @someone', seconds: 300 },
      { id: videoId('brief'), title: 'Made-up brief', seconds: 120 },
      { id: videoId('excl'), title: 'Made-up excluded one' },
      { id: videoId('kw'), title: 'Made-up reaction video' },
      { id: videoId('vlog'), title: 'Made-up vlog' },
      { id: videoId('cat'), title: 'Made-up cat care' },
      { id: videoId('garbled'), title: 'Made-up garbled' },
      { id: videoId('noembed'), title: 'Made-up care two', embeddable: false, madeForKids: true },
    ]
    for (const v of vids) yt.upload(CH, v)
    const c = await creator({ channels: [{ handle: '@madeup', minMinutes: 3, excludeKeywords: 'Reaction\n', playlists: [{ playlist: 'https://www.youtube.com/playlist?list=PLexcluded', rule: 'exclude' }] }] })
    const r = await syncCreator(payload, c.id)
    expect(r.stopped).toBeUndefined()
    const got = byYt(await videosOf(c.id))
    const reason = (s: string) => got.get(videoId(s))?.hiddenReason
    expect(reason('live')).toBe('Rule: live stream')
    expect(reason('short')).toBe('Rule: Short')
    expect(reason('shorts3')).toBe('Rule: Short')
    expect(reason('vert')).toBe('Rule: vertical video')
    expect(reason('reply')).toBe('Rule: comment reply')
    expect(reason('brief')).toBe('Rule: under 3 min')
    expect(reason('excl')).toBe('Rule: excluded playlist')
    expect(reason('kw')).toBe('Rule: mentions “reaction”')
    expect(reason('vlog')).toBe('Type: vlog')
    expect(reason('cat')).toBe('Not about the site’s subject')
    expect(reason('garbled')).toBe('The classifier’s answer couldn’t be read')
    const shown = [...got.values()].filter((d) => d.shown).map((d) => d.youtubeId).sort()
    expect(shown).toEqual([videoId('good'), videoId('noembed')].sort())
    expect(got.get(videoId('noembed'))).toMatchObject({ embeddable: false, madeForKids: true, source: 'api' })
    // Only rule-passing videos go to the classifier, with titles and descriptions only.
    const sent = classifyCalls.flat()
    expect(sent.map((v) => v.title)).not.toContain('Made-up stream')
    expect(Object.keys(sent[0]!).sort()).toEqual(['channel', 'description', 'key', 'title'])
    expect(networkCalls).toEqual([])
  })

  it('include-only playlists hide everything else', async () => {
    const ch = channelId('incl')
    yt.addChannel(ch, '@incl')
    yt.upload(ch, { id: videoId('in1'), title: 'Made-up care in' })
    yt.upload(ch, { id: videoId('out1'), title: 'Made-up care out' })
    yt.playlist('PLinclude', 'Made-up include', [videoId('in1')])
    const c = await creator({ channels: [{ handle: '@incl', playlists: [{ playlist: 'PLinclude', rule: 'include' }] }] })
    await syncCreator(payload, c.id)
    const got = byYt(await videosOf(c.id))
    expect(got.get(videoId('in1'))?.shown).toBe(true)
    expect(got.get(videoId('out1'))?.hiddenReason).toBe('Rule: not in an included playlist')
  })

  it('a picked creator’s passing videos wait for a curator; new creators default to picked; a missing mode counts as picked', async () => {
    const ch = channelId('picked')
    yt.addChannel(ch, '@picked')
    yt.upload(ch, { id: videoId('pk1'), title: 'Made-up care picked' })
    const c = await creator({ videosDefault: 'picked', channels: [{ handle: '@picked' }] })
    await syncCreator(payload, c.id)
    const [v] = await videosOf(c.id)
    expect(v).toMatchObject({ passedRules: true, shown: false, curation: 'picked' })
    const fresh = (await payload.create({ collection: 'creators', data: { tenant: 'A', name: 'Made-up default', channels: [{ handle: '@x' }] } as never })) as unknown as Doc
    expect(fresh.videosDefault).toBe('picked')
    // A stored creator with no value (older records) counts as picked: its new videos wait.
    await payload.db.collections.creators!.updateOne({ _id: c.id }, { $unset: { videosDefault: 1 } })
    yt.upload(ch, { id: videoId('pk2'), title: 'Made-up care picked two' })
    await syncCreator(payload, c.id)
    expect(byYt(await videosOf(c.id)).get(videoId('pk2'))).toMatchObject({ passedRules: true, shown: false, curation: 'picked' })
  })

  it('unclassified videos never show, and get another try next time', async () => {
    const ch = channelId('uncl')
    yt.addChannel(ch, '@uncl')
    yt.upload(ch, { id: videoId('un1'), title: 'Made-up unclassified' })
    const c = await creator({ channels: [{ handle: '@uncl' }] })
    await syncCreator(payload, c.id)
    expect((await videosOf(c.id))[0]).toMatchObject({ shown: false, hiddenReason: 'Not classified yet' })
  })

  it('without a classifier hook, nothing shows by the rules', async () => {
    const ch = channelId('nohook')
    const p2 = await start((o) => ({ ...o, classify: undefined }))
    yt.addChannel(ch, '@nohook')
    yt.upload(ch, { id: videoId('nh1'), title: 'Made-up care' })
    const c = (await p2.create({ collection: 'creators', data: { tenant: 'A', name: 'Made-up', videosDefault: 'rules', channels: [{ handle: '@nohook' }] } as never })) as unknown as Doc
    await syncCreator(p2, c.id)
    const { docs } = await p2.find({ collection: 'videos', overrideAccess: true })
    expect(docs[0]).toMatchObject({ shown: false, passedRules: false })
    await p2.destroy()
  })
})

describe('RSS first', () => {
  it('nothing new in the feed means no API call and no units', async () => {
    const ch = channelId('quiet')
    yt.addChannel(ch, '@quiet')
    yt.upload(ch, { id: videoId('q1'), title: 'Made-up care quiet' })
    yt.playlist('PLquietrule', 'Made-up rule list', [])
    const c = await creator({ channels: [{ handle: '@quiet', playlists: [{ playlist: 'PLquietrule', rule: 'exclude' }] }] })
    await syncCreator(payload, c.id)
    yt.reset()
    await clearUsage()
    const r = await syncCreator(payload, c.id)
    expect(yt.feeds()).toHaveLength(1)
    expect(yt.api()).toEqual([])
    expect(r.units).toBe(0)
    expect(await usage()).toEqual([])
  })

  it('a new video in the feed costs only the details call', async () => {
    const ch = channelId('newone')
    yt.addChannel(ch, '@newone')
    yt.upload(ch, { id: videoId('n1'), title: 'Made-up care one' })
    const c = await creator({ channels: [{ handle: '@newone' }] })
    await syncCreator(payload, c.id)
    yt.reset()
    yt.upload(ch, { id: videoId('n2'), title: 'Made-up care two' })
    const r = await syncCreator(payload, c.id)
    expect(yt.api().map((x) => x.kind)).toEqual(['videos'])
    expect(r.units).toBe(1)
    expect(byYt(await videosOf(c.id)).get(videoId('n2'))?.shown).toBe(true)
  })

  it('a broken feed falls back to the API', async () => {
    const ch = channelId('broken')
    yt.addChannel(ch, '@broken')
    yt.upload(ch, { id: videoId('b1'), title: 'Made-up care b' })
    const c = await creator({ channels: [{ handle: '@broken' }] })
    await syncCreator(payload, c.id)
    yt.upload(ch, { id: videoId('b2'), title: 'Made-up care b2' })
    yt.feedState.broken = true
    yt.reset()
    const r = await syncCreator(payload, c.id)
    expect(yt.api().map((x) => x.kind)).toContain('playlistItems')
    expect(byYt(await videosOf(c.id)).has(videoId('b2'))).toBe(true)
    expect(r.note).toContain('Used the API instead')
  })

  it('without a key, new feed videos are cataloged for review and never shown by the rules', async () => {
    state.key = null
    const ch = channelId('nokey')
    yt.addChannel(ch, '@nokey')
    yt.upload(ch, { id: videoId('nk1'), title: 'Made-up care &amp; more', description: 'Made-up <b>' })
    const c = await creator({ channels: [{ handle: `https://www.youtube.com/channel/${ch}` }] })
    const r = await syncCreator(payload, c.id)
    expect(yt.api()).toEqual([])
    const [v] = await videosOf(c.id)
    expect(v).toMatchObject({ source: 'rss', shown: false, passedRules: false, title: 'Made-up care &amp; more' })
    expect(r.review).toBe(1)
    expect(r.note).toContain('No API key')
  })

  it('a handle without a key or a channel link gets a plain note, and no call', async () => {
    state.key = null
    const c = await creator({ channels: [{ handle: '@nobodyknows' }] })
    const r = await syncCreator(payload, c.id)
    expect(yt.calls).toEqual([])
    expect(r.note).toContain('paste the channel link')
  })
})

describe('gates', () => {
  it('never reads the key from the environment', async () => {
    process.env.YT_DATA_API_KEY = 'made-up-env-key'
    try {
      state.key = null
      const ch = channelId('envkey')
      yt.addChannel(ch, '@envkey')
      const c = await creator({ channels: [{ handle: '@envkey' }] })
      await syncCreator(payload, c.id)
      expect(yt.api()).toEqual([])
      expect(yt.keysSeen).not.toContain('made-up-env-key')
    } finally {
      delete process.env.YT_DATA_API_KEY
    }
  })

  for (const value of [false, 1, 'true', {}, undefined, null, Promise.resolve(1)])
    it(`\`enabled\` answering ${JSON.stringify(value) ?? String(value)} means no outside call at all, RSS included`, async () => {
      state.enabled = value
      const c = await creator({ channels: [{ handle: `https://www.youtube.com/channel/${channelId('gate')}` }] })
      const r = await syncCreator(payload, c.id)
      expect(r.skipped).toBe('disabled')
      expect(yt.calls).toEqual([])
    })

  it('`enabled` throwing is a no', async () => {
    const p2 = await start((o) => ({ ...o, enabled: () => { throw new Error('made-up') } }))
    const c = (await p2.create({ collection: 'creators', data: { tenant: 'A', name: 'Made-up', channels: [{ handle: '@x' }] } as never })) as unknown as Doc
    expect((await syncCreator(p2, c.id)).skipped).toBe('disabled')
    expect(yt.calls).toEqual([])
    await p2.destroy()
  })

  it('the key never appears in a note, a report or an error', async () => {
    const ch = channelId('leaky')
    yt.addChannel(ch, '@leaky')
    yt.upload(ch, { id: videoId('lk1'), title: 'Made-up care' })
    yt.failNext.push({ status: 400, reason: 'badRequest' })
    const c = await creator({ channels: [{ handle: '@leaky' }] })
    yt.feedState.broken = true
    const r = await syncCreator(payload, c.id)
    expect(r.note).toContain('Sync stopped')
    expect(JSON.stringify(r)).not.toContain(KEY)
    const stored = (await payload.findByID({ collection: 'creators', id: c.id, overrideAccess: true })) as unknown as Doc
    expect(stored.syncNote).not.toContain(KEY)
    expect(stored.syncNote).not.toContain('googleapis')
  })

  it('a creator who asked not to be featured is never synced', async () => {
    const c = await creator({ doNotFeature: true, channels: [{ handle: `https://www.youtube.com/channel/${channelId('dnf')}` }] })
    expect((await syncCreator(payload, c.id)).skipped).toBe('do-not-feature')
    expect(yt.calls).toEqual([])
  })

  it('a second run of the same creator is refused while the first holds the lock', async () => {
    const c = await creator({ syncingSince: new Date().toISOString(), channels: [{ handle: '@busy' }] })
    expect((await syncCreator(payload, c.id)).skipped).toBe('busy')
    const old = await creator({ syncingSince: new Date(Date.now() - 16 * 60_000).toISOString(), channels: [{ handle: `https://www.youtube.com/channel/${channelId('stale')}` }] })
    expect((await syncCreator(payload, old.id)).skipped).toBeUndefined()
  })
})

describe('quota', () => {
  it('the daily cap stops runs cleanly, with a note, and never goes over', async () => {
    const ch = channelId('capped')
    yt.addChannel(ch, '@capped')
    for (let i = 0; i < 3; i++) yt.upload(ch, { id: videoId(`cap${i}`), title: 'Made-up care' })
    const c = await creator({ channels: [{ handle: '@capped' }] })
    await payload.db.collections['playlists-usage']!.collection.updateOne({ day: (await import('../src/index.js')).dayOf(new Date(), 'America/Los_Angeles') }, { $set: { units: 49, quotaStopped: false, bySite: {}, digests: {} } }, { upsert: true })
    const r = await syncCreator(payload, c.id)
    expect(r.stopped).toBe('cap')
    expect(r.note).toContain('cap of 50 units')
    const [day] = await usage()
    expect(day!.units).toBeLessThanOrEqual(50)
  })

  it('the ledger refuses every reservation after a quota stop, even for a run already going', async () => {
    const { ledger } = await import('../src/ledger.js')
    const { optionsOf } = await import('../src/index.js')
    const book = ledger(payload, optionsOf(payload), () => new Date())
    expect(await book.reserve(1, 'A')).toBe('ok')
    await book.stopForQuota()
    expect(await book.reserve(1, 'A')).toBe('quota')
    expect(await book.reserve(0, 'A')).not.toBe('ok')
  })

  it('a quota error stops every creator until the reset, and lastRecheckAt waits', async () => {
    const ch = channelId('quota')
    yt.addChannel(ch, '@quota')
    yt.upload(ch, { id: videoId('qa1'), title: 'Made-up care' })
    const c = await creator({ channels: [{ handle: '@quota' }] })
    yt.failNext.push({ status: 403, reason: 'quotaExceeded' })
    const r = await syncCreator(payload, c.id, { recheck: true })
    expect(r.stopped).toBe('quota')
    const [day] = await usage()
    expect(day!.quotaStopped).toBe(true)
    yt.reset()
    const other = await creator({ channels: [{ handle: `https://www.youtube.com/channel/${channelId('other')}` }] })
    yt.addChannel(channelId('other'), '@other')
    yt.upload(channelId('other'), { id: videoId('ot1'), title: 'Made-up care' })
    const r2 = await syncCreator(payload, other.id)
    expect(yt.api()).toEqual([])
    expect(r2.stopped).toBe('quota')
    const stored = (await payload.findByID({ collection: 'creators', id: c.id, overrideAccess: true })) as unknown as Doc
    expect(stored.lastRecheckAt ?? null).toBeNull()
  })

  it('a rate limit or 5xx is retried twice, after 2 and 8 seconds, then the run stops', async () => {
    const ch = channelId('retry')
    yt.addChannel(ch, '@retry')
    yt.upload(ch, { id: videoId('rt1'), title: 'Made-up care' })
    yt.failNext.push({ status: 503, reason: 'backendError' }, { status: 429, reason: 'rateLimitExceeded' })
    const c = await creator({ channels: [{ handle: '@retry' }] })
    const r = await syncCreator(payload, c.id)
    expect(state.sleeps).toEqual([2000, 8000])
    expect(r.stopped).toBeUndefined()
    expect(r.added).toBe(1)
    yt.failNext.push({ status: 500, reason: 'backendError' }, { status: 500, reason: 'backendError' }, { status: 500, reason: 'backendError' })
    state.sleeps = []
    yt.feedState.broken = true
    const r2 = await syncCreator(payload, c.id)
    expect(state.sleeps).toEqual([2000, 8000])
    expect(r2.note).toContain('Sync stopped')
  })
})

describe('re-check, gone videos and locks', () => {
  it('marks gone videos, keeps a curator’s choice, and clears the mark when they return', async () => {
    const ch = channelId('gone')
    yt.addChannel(ch, '@gone')
    yt.upload(ch, { id: videoId('g1'), title: 'Made-up care gone' })
    const c = await creator({ channels: [{ handle: '@gone' }] })
    await syncCreator(payload, c.id)
    const [v] = await videosOf(c.id)
    await payload.update({ collection: 'videos', id: v!.id, data: { choice: 'show' } as never, overrideAccess: true })
    yt.video(videoId('g1'))!.gone = true
    const r = await syncCreator(payload, c.id, { recheck: true })
    expect(r.unavailable).toBe(1)
    let [after] = await videosOf(c.id)
    expect(after).toMatchObject({ unavailable: true, shown: false, choice: 'show', title: 'Made-up care gone' })
    yt.video(videoId('g1'))!.gone = false
    yt.video(videoId('g1'))!.title = 'Made-up care renamed'
    const r2 = await syncCreator(payload, c.id, { recheck: true })
    expect(r2.returned).toBe(1)
    ;[after] = await videosOf(c.id)
    expect(after).toMatchObject({ unavailable: false, shown: true, choice: 'show', title: 'Made-up care renamed' })
  })

  it('a locked video keeps the person’s changes through a sync', async () => {
    const ch = channelId('locked')
    yt.addChannel(ch, '@locked')
    yt.upload(ch, { id: videoId('lo1'), title: 'Made-up care locked' })
    const c = await creator({ channels: [{ handle: '@locked', excludeKeywords: '' }] })
    await syncCreator(payload, c.id)
    const [v] = await videosOf(c.id)
    await payload.update({ collection: 'videos', id: v!.id, data: { kind: 'build', locked: true } as never, overrideAccess: true })
    await payload.update({ collection: 'creators', id: c.id, data: { channels: [{ ...c.channels[0], channelId: ch, excludeKeywords: 'care' }] } as never, overrideAccess: true })
    await syncCreator(payload, c.id)
    const [after] = await videosOf(c.id)
    expect(after).toMatchObject({ kind: 'build', locked: true })
    expect(after!.hiddenReason).toBeNull()
  })

  it('a changed rule re-judges stored videos', async () => {
    const ch = channelId('rejudge')
    yt.addChannel(ch, '@rejudge')
    yt.upload(ch, { id: videoId('rj1'), title: 'Made-up care with snails' })
    const c = await creator({ channels: [{ handle: '@rejudge' }] })
    await syncCreator(payload, c.id)
    expect((await videosOf(c.id))[0]!.shown).toBe(true)
    const stored = (await payload.findByID({ collection: 'creators', id: c.id, overrideAccess: true })) as unknown as Doc
    await payload.update({ collection: 'creators', id: c.id, data: { channels: [{ ...stored.channels[0], excludeKeywords: 'snails' }] } as never, overrideAccess: true })
    await syncCreator(payload, c.id)
    expect((await videosOf(c.id))[0]).toMatchObject({ shown: false, hiddenReason: 'Rule: mentions “snails”' })
  })

  it('goneVideos "clear" keeps only the site’s own notes after the grace period; "keep" keeps everything', async () => {
    const p2 = await start((o) => ({ ...o, goneVideos: { mode: 'clear', clearAfterDays: 30 } }))
    const ch = channelId('clear')
    yt.addChannel(ch, '@clear')
    yt.upload(ch, { id: videoId('cl1'), title: 'Made-up care to clear' })
    const c = (await p2.create({ collection: 'creators', data: { tenant: 'A', name: 'Made-up', videosDefault: 'rules', channels: [{ handle: '@clear' }] } as never })) as unknown as Doc
    await syncCreator(p2, c.id)
    yt.video(videoId('cl1'))!.gone = true
    await syncCreator(p2, c.id, { recheck: true })
    let { docs } = await p2.find({ collection: 'videos', overrideAccess: true })
    expect(docs[0]).toMatchObject({ unavailable: true, title: 'Made-up care to clear' })
    const r = await syncCreator(p2, c.id, { now: new Date(Date.now() + 31 * 86_400_000) })
    expect(r.cleared).toBe(1)
    ;({ docs } = await p2.find({ collection: 'videos', overrideAccess: true }))
    expect(docs[0]).toMatchObject({ title: GONE_TITLE, youtubeId: videoId('cl1') })
    expect((docs[0] as Doc).description ?? null).toBeNull()
    expect((docs[0] as Doc).thumbnail ?? null).toBeNull()
    await p2.destroy()
  })
})

describe('the cron', () => {
  it('syncs only the creators that are due, in the site’s time zone, and never one that asked not to be featured', async () => {
    const p2 = await start((o) => ({ ...o, schedule: { timeZone: 'Etc/GMT+7', defaultHour: 12 } }))
    const ch = channelId('cron')
    yt.addChannel(ch, '@cron')
    const mk = (data: Doc) => p2.create({ collection: 'creators', data: { tenant: 'A', name: `Made-up ${Math.random()}`, channels: [{ handle: `https://www.youtube.com/channel/${ch}` }], ...data } as never })
    const noon = new Date('2026-11-11T19:30:00Z') // 12:30 at UTC-7, a Wednesday
    await mk({ lastSyncedAt: '2026-11-11T18:00:00Z' }) // before today's noon: due
    await mk({ lastSyncedAt: '2026-11-11T19:10:00Z' }) // after today's noon: not due
    await mk({ syncDays: ['sun'], lastSyncedAt: '2026-11-09T00:00:00Z' }) // Sundays only: last slot was Sunday the 8th, synced since
    await mk({ doNotFeature: true })
    const r = await syncDue(p2, { now: noon })
    expect(r.due).toBe(1)
    expect(r.synced).toBe(1)
    await p2.destroy()
  })
})
