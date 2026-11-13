import type { CollectionConfig, PayloadRequest } from 'payload'
import { describe, expect, it } from 'vitest'

import { createAccess, curateAccess, editAccess, exactlyTrue, queryGuard, staffField, readCreators, readVideos } from '../src/access.js'
import { queueSitesOf } from '../src/curation.js'
import { protect, functionsOf } from '../src/protect.js'
import { watchlist, checkOptions, computeShown, dataApi, isDue, isShort, lastSlot, parseFeed, ruleHide, seconds, youtubeImage, channelIdOf, YouTubeError, type WatchlistOptions } from '../src/index.js'
import { scrub } from '../src/youtube.js'
import { channelId, videoId } from './harness.js'

// Pure parts: the fail-closed gates, the overrides, the rules, the feed parser, the API client's errors, the schedule.

const config = { collections: [{ slug: 'users', auth: true, fields: [] }, { slug: 'taxa', fields: [] }] } as never
const base = (scope: Partial<WatchlistOptions['scope']> = {}): WatchlistOptions => ({ scope: { field: 'tenant', ofRequest: () => 'A', sitesFor: () => ['A'], isAdmin: () => false, ...scope }, enabled: () => true })
const req = {} as PayloadRequest
const build = (o: WatchlistOptions, c: unknown = { collections: [] }) => watchlist(o)(c as never) as import('payload').Config
const run = async (access: unknown) => (access as (a: { req: PayloadRequest }) => unknown)({ req: { ...req } })

describe('gates fail closed', () => {
  const weird: [string, () => unknown][] = [
    ['1', () => 1],
    ['"true"', () => 'true'],
    ['{}', () => ({})],
    ['a promise of 1', () => Promise.resolve(1)],
    ['a rejected promise', () => Promise.reject(new Error('made-up'))],
    ['a throw', () => { throw new Error('made-up') }],
    ['undefined', () => undefined],
  ]
  for (const [label, fn] of weird) {
    it(`exactlyTrue refuses ${label}`, async () => expect(await exactlyTrue(fn)).toBe(false))
    it(`isAdmin answering ${label} grants nothing`, async () => {
      const o = checkOptions(base({ isAdmin: fn as never, sitesFor: () => [] }), config)
      for (const a of [editAccess(o), curateAccess(o), createAccess(o)]) expect(await run(a)).toBe(false)
      // Reads fall back to the public view, never everything.
      expect(await run(readVideos(o))).not.toBe(true)
    })
    it(`sitesFor answering ${label} is no role`, async () => {
      const o = checkOptions(base({ sitesFor: fn as never }), config)
      for (const a of [editAccess(o), curateAccess(o), createAccess(o)]) expect(await run(a)).toBe(false)
    })
  }
  // A site id is a string or a number, so 1 and "true" are sites; anything else is no site.
  for (const [label, fn] of [['{}', () => ({})], ['an empty string', () => ''], ['NaN', () => Number.NaN], ['a throw', () => { throw new Error('made-up') }], ['a rejected promise', () => Promise.reject(new Error('x'))], ['undefined', () => undefined], ['an array', () => ['A']]] as [string, () => unknown][])
    it(`ofRequest answering ${label} means no public reads`, async () => {
      const o = checkOptions(base({ ofRequest: fn as never, sitesFor: () => [] }), config)
      expect(await run(readVideos(o))).toBe(false)
      expect(await run(readCreators(o))).toBe(false)
    })
  it('exactlyTrue passes only true', async () => expect(await exactlyTrue(() => Promise.resolve(true))).toBe(true))
  it('sitesFor with junk inside the array keeps only site ids', async () => {
    const o = checkOptions(base({ sitesFor: () => [null, {}, '', 'A'] as never }), config)
    expect(await run(editAccess(o))).toEqual({ tenant: { in: ['A'] } })
  })
})

describe('options', () => {
  it('refuses missing or wrong providers', () => {
    expect(() => checkOptions(undefined as never, config)).toThrow(/needs its options/)
    expect(() => checkOptions({ ...base(), scope: { field: 'tenant', sitesFor: () => [], isAdmin: () => false } } as never, config)).toThrow(/ofRequest/)
    expect(() => checkOptions({ ...base(), enabled: true } as never, config)).toThrow(/enabled/)
    expect(() => checkOptions({ ...base(), youtube: { apiKey: 'a-key' } } as never, config)).toThrow(/never reads the environment/)
    expect(() => checkOptions({ ...base(), shownKinds: ['not-a-kind'] }, config)).toThrow(/shownKinds/)
    expect(() => checkOptions({ ...base(), schedule: { timeZone: 'Mars/Base' } }, config)).toThrow(/time zones/)
    for (const cooldownMinutes of [-1, 1.5, '10']) expect(() => checkOptions({ ...base(), syncNow: { cooldownMinutes } } as never, config)).toThrow(/cooldownMinutes/)
    for (const siteDailyUnitCap of [0, 2.5, 2001]) expect(() => checkOptions({ ...base(), youtube: { siteDailyUnitCap } }, config)).toThrow(/siteDailyUnitCap/)
    expect(() => checkOptions({ ...base(), topics: { relationTo: 'nope', resolve: () => null } }, config)).toThrow(/nope/)
  })
  it('defaults (owner, 2026-11-11): rules for new creators, per creator, gone videos kept until the terms check, 700 description characters', () => {
    const o = checkOptions(base(), config)
    expect([o.videosDefault, o.curationLevel, o.goneMode, o.descriptionChars, o.dailyUnitCap, o.urgentAt]).toEqual(['picked', 'creator', 'keep', 700, 2000, 25])
    // Sync now rests a creator for 10 minutes; a site may use the whole cap unless a share is set.
    expect([o.syncNowCooldownMs, o.siteDailyUnitCap]).toEqual([600_000, null])
    expect(checkOptions({ ...base(), syncNow: { cooldownMinutes: 0 }, youtube: { siteDailyUnitCap: 500 } }, config)).toMatchObject({ syncNowCooldownMs: 0, siteDailyUnitCap: 500 })
  })
  it('a site that passes its own kinds but no shownKinds shows nothing by the rules', () => {
    expect(checkOptions({ ...base(), kinds: [{ label: 'A', value: 'a' }] }, config).shownKinds).toEqual([])
  })
})

describe('overrides can’t remove the plugin’s rules', () => {
  const coll = (): CollectionConfig => ({
    slug: 'videos',
    access: { read: () => ({ shown: { equals: true } }) },
    hooks: { beforeChange: [({ data }) => data] },
    fields: [{ name: 'shown', type: 'checkbox' }, { name: 'title', type: 'text' }],
  })
  it('a removed field or a changed type is refused', () => {
    const b = coll()
    expect(() => protect(b, { ...coll(), fields: [{ name: 'title', type: 'text' }] }, functionsOf(coll()))).toThrow(/removed the field "shown"/)
    expect(() => protect(b, { ...coll(), fields: [{ name: 'shown', type: 'text' }, { name: 'title', type: 'text' }] }, functionsOf(coll()))).toThrow(/changed the field "shown"/)
    expect(() => protect(b, { ...coll(), slug: 'other' }, functionsOf(coll()))).toThrow(/slug/)
  })
  it('access is only narrowed, and the plugin’s hooks run first', async () => {
    const b = coll()
    const copy = coll()
    const mine = () => true
    const out = protect(b, { ...copy, access: { read: () => true }, hooks: { beforeChange: [mine as never] } }, functionsOf(copy))
    expect(await run(out.access!.read)).toEqual({ shown: { equals: true } })
    expect(out.hooks!.beforeChange![0]).toBe(b.hooks!.beforeChange![0])
    expect(out.hooks!.beforeChange).toContain(mine)
    const throwing = protect(b, { ...coll(), access: { read: () => { throw new Error('made-up') } } }, functionsOf(coll()))
    expect(await run(throwing.access!.read)).toBe(false)
  })
  it('the plugin’s routes stay, and stay first, whatever an override does to the endpoints', () => {
    const built = (overrides: WatchlistOptions['overrides']) => build({ ...base(), overrides }).collections!
    const routes = (c: CollectionConfig) => (Array.isArray(c.endpoints) ? c.endpoints.map((e) => `${e.method} ${e.path}`) : [])
    const plain = built(undefined)
    expect(routes(plain.find((c) => c.slug === 'creators')!)).toEqual(['post /:id/sync'])
    expect(routes(plain.find((c) => c.slug === 'videos')!)).toEqual(['post /:id/review'])
    const shadow = { path: '/:id/sync', method: 'post' as const, handler: () => new Response('made-up') }
    const own = { path: '/mine', method: 'get' as const, handler: () => new Response('made-up') }
    const changed = built({ creators: (c) => ({ ...c, endpoints: [shadow, own] }), videos: (c) => ({ ...c, endpoints: false }) })
    const creators = changed.find((c) => c.slug === 'creators')!
    expect(routes(creators)).toEqual(['post /:id/sync', 'post /:id/sync', 'get /mine'])
    expect((creators.endpoints as { handler: unknown }[])[0]!.handler).not.toBe(shadow.handler)
    expect((creators.endpoints as { handler: unknown }[])[0]).toBe((plain.find((c) => c.slug === 'creators')!.endpoints as unknown[])[0])
    expect(routes(changed.find((c) => c.slug === 'videos')!)).toEqual(['post /:id/review'])
  })
})

describe('whose review queue', () => {
  it('a signed-out request holds no queue, even when the site’s providers would say yes to it', async () => {
    const o = checkOptions(base({ isAdmin: () => true, sitesFor: () => ['A'] }), config)
    expect(await queueSitesOf(o, {} as PayloadRequest)).toBeNull()
    expect(await queueSitesOf(o, { user: null } as unknown as PayloadRequest, 'A')).toBeNull()
    expect(await queueSitesOf(o, { user: { id: 'made-up' } } as unknown as PayloadRequest)).toEqual({ sites: null })
  })
})

describe('the admin’s view, link and button', () => {
  const PKG = '@extantape/payload-plugin-watchlist'
  it('are registered by the plugin, beside whatever the site already has', () => {
    const out = build(base(), { collections: [], admin: { components: { afterNavLinks: ['site#Link'], views: { site: { Component: 'site#View', path: '/site' } } } } })
    expect(out.admin!.components!.afterNavLinks).toEqual(['site#Link', `${PKG}/rsc#ReviewNavLink`])
    expect(out.admin!.components!.views).toMatchObject({ site: { path: '/site' }, watchlistReview: { Component: `${PKG}/rsc#ReviewView`, path: '/watchlist-review', exact: true } })
    const field = out.collections!.find((c) => c.slug === 'creators')!.fields.find((f) => 'name' in f && f.name === 'syncNow') as { type: string; admin: { components: { Field: string } } }
    // A UI field: Payload stores nothing for it.
    expect(field.type).toBe('ui')
    expect(field.admin.components.Field).toBe(`${PKG}/rsc#SyncNowField`)
  })
  it('the site can move the view, or leave the view and link out; a bad path is refused', () => {
    expect((build({ ...base(), admin: { reviewPath: '/watch-review' } }).admin!.components!.views as Record<string, { path: string }>).watchlistReview!.path).toBe('/watch-review')
    const off = build({ ...base(), admin: false })
    expect(off.admin?.components?.views).toBeUndefined()
    expect(off.admin?.components?.afterNavLinks).toBeUndefined()
    for (const reviewPath of ['watch', '/', '/a b', '//x', 'https://example.test', '/x?y=1']) expect(() => checkOptions({ ...base(), admin: { reviewPath } }, config)).toThrow(/admin.reviewPath/)
  })
})

describe('the rules', () => {
  const r = { include: new Set<string>(), exclude: new Set<string>(), topic: new Set<string>(), keywords: [] as string[] }
  const v = (x: Partial<Parameters<typeof ruleHide>[0]>) => ({ id: 'x', title: 'Made-up', description: '', duration: 600, live: false, ...x })
  it('Shorts are up to 61 seconds, or 3 minutes with #shorts', () => {
    expect(isShort({ duration: 61, title: '', description: '' })).toBe(true)
    expect(isShort({ duration: 62, title: '', description: '' })).toBe(false)
    expect(isShort({ duration: 180, title: '', description: 'a #short' })).toBe(true)
    expect(isShort({ duration: 181, title: '#shorts', description: '' })).toBe(false)
  })
  it('a live stream is checked first', () => expect(ruleHide(v({ live: true, duration: 10 }), r)).toBe('Rule: live stream'))
  it('topic playlists count as included', () => {
    expect(ruleHide(v({ id: 't' }), { ...r, include: new Set(['i']), topic: new Set(['t']) })).toBeNull()
  })
  it('computeShown: a choice wins; otherwise only rules + passed + API details; gone never shows', () => {
    expect(computeShown({ choice: 'show' })).toBe(true)
    expect(computeShown({ choice: 'hide', curation: 'rules', passedRules: true, source: 'api' })).toBe(false)
    expect(computeShown({ curation: 'rules', passedRules: true, source: 'api' })).toBe(true)
    expect(computeShown({ curation: 'picked', passedRules: true, source: 'api' })).toBe(false)
    expect(computeShown({ curation: undefined, passedRules: true, source: 'api' })).toBe(false)
    expect(computeShown({ curation: 'rules', passedRules: true, source: 'rss' })).toBe(false)
    expect(computeShown({ curation: 'rules', passedRules: 1 as never, source: 'api' })).toBe(false)
    expect(computeShown({ choice: 'show', unavailable: true })).toBe(false)
  })
  it('images only from YouTube’s own hosts over https', () => {
    expect(youtubeImage('https://i.ytimg.com/vi/x/hq.jpg')).toBe('https://i.ytimg.com/vi/x/hq.jpg')
    for (const bad of ['http://i.ytimg.com/x.jpg', 'https://example.com/x.jpg', 'https://i.ytimg.com.example.com/x', 'javascript:alert(1)', `https://user${'@'}i.ytimg.com/x`, 'https://i.ytimg.com:8443/x', '']) expect(youtubeImage(bad)).toBeNull()
  })
  it('a channel ID from a pasted link, never from a handle', () => {
    const id = channelId('link')
    expect(channelIdOf(`https://www.youtube.com/channel/${id}`)).toBe(id)
    expect(channelIdOf('@handle')).toBeNull()
    expect(channelIdOf(`https://evil.example/youtube.com/channel/${id}x`)).toBeNull()
  })
})

describe('the feed parser', () => {
  it('reads entries, decodes text, and keeps only YouTube images and valid IDs', () => {
    const xml = `<feed><entry><yt:videoId>${videoId('a')}</yt:videoId><title>Tom &amp; Jerry&#39;s &lt;care&gt;</title><published>2026-11-01T00:00:00+00:00</published><media:thumbnail url="https://i.ytimg.com/vi/a/hq.jpg"/><media:description><![CDATA[Made-up]]></media:description></entry><entry><yt:videoId>bad id</yt:videoId><title>x</title></entry><entry><yt:videoId>${videoId('b')}</yt:videoId><title>b</title><media:thumbnail url="https://evil.example/x.jpg"/></entry></feed>`
    const out = parseFeed(xml)
    expect(out.map((e) => e.id)).toEqual([videoId('a'), videoId('b')])
    expect(out[0]).toMatchObject({ title: 'Tom & Jerry\'s <care>', description: 'Made-up', thumbnail: 'https://i.ytimg.com/vi/a/hq.jpg' })
    expect(out[1]!.thumbnail).toBeNull()
  })
  it('refuses anything that isn’t a feed', () => expect(() => parseFeed('<html></html>')).toThrow(/Not a feed/))
})

describe('the Data API client', () => {
  it('turns durations into seconds', () => {
    expect(seconds('PT1H2M3S')).toBe(3723)
    expect(seconds('P1DT1S')).toBe(86401)
    expect(seconds('nonsense')).toBe(0)
  })
  it('errors carry YouTube’s message without the key or the URL', async () => {
    const key = 'made-up-key-abcdef'
    const api = dataApi(key, (async () => new Response(JSON.stringify({ error: { message: `bad key ${key} at https://www.googleapis.com/x?key=${key}`, errors: [{ reason: 'keyInvalid' }] } }), { status: 400 })) as never)
    const error = (await api.videos([videoId('x')]).catch((e: unknown) => e)) as YouTubeError
    expect(error).toBeInstanceOf(YouTubeError)
    expect(error.failure).toBe('other')
    expect(error.message).not.toContain(key)
    expect(error.message).not.toContain('googleapis')
    expect(scrub(`a ${key} b`, key)).toBe('a [key] b')
  })
  it('a network failure is a retry and says nothing of the URL', async () => {
    const api = dataApi('k-123', (async (u: string) => { throw new Error(`failed ${u}`) }) as never)
    const error = (await api.videos([videoId('x')]).catch((e: unknown) => e)) as YouTubeError
    expect(error.failure).toBe('retry')
    expect(error.message).not.toContain('k-123')
  })
  it('only an explicit embeddable true embeds', async () => {
    const api = dataApi('k', (async () => new Response(JSON.stringify({ items: [{ id: videoId('e'), snippet: { title: 't', publishedAt: '2026-11-01' }, contentDetails: { duration: 'PT5M' } }] }))) as never)
    expect((await api.videos([videoId('e')]))[0]).toMatchObject({ embeddable: false, madeForKids: null })
  })
})

describe('the schedule', () => {
  it('is daily at the default hour in the site’s zone', () => {
    const now = new Date('2026-11-11T19:30:00Z')
    expect(lastSlot(now, {}, 'Etc/GMT+7', 12)!.toISOString()).toBe('2026-11-11T19:00:00.000Z')
    expect(lastSlot(new Date('2026-11-11T18:30:00Z'), {}, 'Etc/GMT+7', 12)!.toISOString()).toBe('2026-11-10T19:00:00.000Z')
  })
  it('follows daylight saving in zones that have it', () => {
    expect(lastSlot(new Date('2026-07-01T23:00:00Z'), {}, 'America/New_York', 12)!.toISOString()).toBe('2026-07-01T16:00:00.000Z')
    expect(lastSlot(new Date('2026-12-01T23:00:00Z'), {}, 'America/New_York', 12)!.toISOString()).toBe('2026-12-01T17:00:00.000Z')
  })
  it('picked days and hours; bad values fall back', () => {
    const now = new Date('2026-11-11T19:30:00Z') // Wednesday
    expect(lastSlot(now, { syncDays: ['sun'], syncHour: 9 }, 'UTC', 12)!.toISOString()).toBe('2026-11-08T09:00:00.000Z')
    expect(lastSlot(now, { syncDays: ['nope'] }, 'UTC', 12)).toBeNull()
    expect(lastSlot(now, { syncHour: 99 }, 'UTC', 12)!.toISOString()).toBe('2026-11-11T12:00:00.000Z')
    expect(isDue(now, { lastSyncedAt: 'not a date' })).toBe(true)
  })
})

describe('the query guard on its own', () => {
  const internal = { own: ['claim', 'channels.uploads'], related: { creator: ['syncNote'] } }
  const guardFor = (sites: string[]) => queryGuard(checkOptions(base({ sitesFor: () => sites }), config), internal) as unknown as (a: { args: Record<string, unknown>; operation: string; req: PayloadRequest }) => Promise<Record<string, unknown>>
  const ask = (sites: string[], args: Record<string, unknown>, operation = 'read') => guardFor(sites)({ args, operation, req: { t: (k: string) => k } as never })
  for (const [label, args] of [
    ['a filter', { where: { claim: { exists: true } } }],
    ['an or', { where: { or: [{ title: { exists: true } }, { claim: { exists: true } }] } }],
    ['an and inside an or', { where: { or: [{ and: [{ claim: { equals: 'x' } }] }] } }],
    ['a nested array field', { where: { 'channels.uploads': { exists: true } } }],
    ['a relationship path', { where: { 'creator.syncNote': { exists: true } } }],
    ['a sort', { sort: '-claim' }],
    ['a sort list', { sort: ['title', 'claim'] }],
    ['a distinct field', { field: 'claim' }],
  ] as [string, Record<string, unknown>][])
    it(`refuses ${label} on an internal field for someone without a role`, async () => {
      await expect(ask([], { ...args })).rejects.toThrow()
    })
  it('keeps a curator’s internal filter to their own sites, and leaves public filters alone', async () => {
    expect((await ask(['A'], { where: { claim: { exists: true } } })).where).toEqual({ and: [{ claim: { exists: true } }, { tenant: { in: ['A'] } }] })
    expect((await ask(['A'], { sort: 'claim' })).where).toEqual({ tenant: { in: ['A'] } })
    expect((await ask([], { where: { title: { like: 'x' } }, sort: '-publishedAt' })).where).toEqual({ title: { like: 'x' } })
    expect(await ask([], { where: { claim: { exists: true } } }, 'update')).toBeTruthy()
  })
})

describe('internal field access on its own', () => {
  const field = (sites: string[], admin = false) => staffField(checkOptions(base({ sitesFor: () => sites, isAdmin: () => admin }), config)) as unknown as (a: { req: PayloadRequest; doc?: Record<string, unknown> }) => Promise<boolean>
  it('without a record (a filter), only someone with a role or an admin passes', async () => {
    expect(await field([])({ req: { ...req } })).toBe(false)
    expect(await field(['A'])({ req: { ...req } })).toBe(true)
    expect(await field([], true)({ req: { ...req } })).toBe(true)
  })
  it('with a record, only its own site’s curators and editors', async () => {
    expect(await field(['A'])({ req: { ...req }, doc: { tenant: 'A' } })).toBe(true)
    expect(await field(['B'])({ req: { ...req }, doc: { tenant: 'A' } })).toBe(false)
    expect(await field([])({ req: { ...req }, doc: { tenant: 'A' } })).toBe(false)
  })
})
