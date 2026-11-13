import { createLocalReq, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getCreator, getVideo, isError, listCreators, listVideos, MESSAGES } from '../src/server/index.js'
import { as, channelId, person, startPayload, stopMongo, tokenOf, videoId, type Harness, type Person } from './harness.js'

// Phase 2, the public side: the server functions the site's pages call, and the fields those pages read. Every read is
// made as a signed-out visitor of the request's site, whoever is looking. Made-up creators, videos and topics.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
let h: Harness
let payload: Payload
let member: Person, curator: Person, staff: Person, staffB: Person, admin: Person
const tokens: Record<string, string> = {}
const ids: Record<string, string> = {}
const SECRETS = ['made-up-secret-keyword', 'Made-up sync note', 'Made-up contact note', 'Made-up reason', 'UUmadeupuploads', 'made-up-backfill', 'made-up-claim']

const reqOf = (p: Person | null, site?: string) => createLocalReq({ user: (p ?? undefined) as never, context: site ? { site } : {} }, payload)
const visitor = (site?: string) => reqOf(null, site)
const titles = (r: unknown) => ((r as Doc).videos as Doc[]).map((v) => v.title).sort()

beforeAll(async () => {
  h = await startPayload(
    (o) => ({ ...o, topics: { relationTo: 'taxa', field: 'species', stateField: 'speciesState', namesField: 'speciesNames', modeField: 'speciesMode', titlesField: 'speciesTitles', playlistRule: 'species', resolve: () => null } }),
    { collections: [{ slug: 'taxa', fields: [{ name: 'name', type: 'text' }] }] },
  )
  payload = h.payload
  member = await person(payload, 'A')
  curator = await person(payload, 'A', 'curator')
  staff = await person(payload, 'A', 'staff')
  staffB = await person(payload, 'B', 'staff')
  admin = await person(payload, 'A', 'admin')
  for (const p of [member, curator, staff, staffB, admin]) tokens[p.id] = await tokenOf(payload, p)
  ids.t1 = String((await payload.create({ collection: 'taxa', data: { name: 'Madeupus one' } as never })).id)
  ids.t2 = String((await payload.create({ collection: 'taxa', data: { name: 'Madeupus two' } as never })).id)
  const creator = async (name: string, data: Doc = {}, site = 'A') => String((await payload.create({ collection: 'creators', data: { tenant: site, name, videosDefault: 'rules', channels: [{ handle: `@${name.toLowerCase().replace(/\W+/g, '')}` }], ...data } as never })).id)
  ids.alpha = await creator('Made-up Alpha', {
    bio: 'Made-up bio',
    website: 'https://example.test/alpha',
    avatar: 'https://yt3.ggpht.com/made-up',
    syncNote: 'Made-up sync note',
    doNotFeatureNote: 'Made-up contact note',
    syncHour: 7,
    showsDisplay: 'own',
    shows: [{ playlist: 'PLshow', name: 'Made-up show', kind: 'show' }],
    channels: [{ handle: '@alpha', title: 'Alpha channel', channelId: channelId('alpha'), excludeKeywords: 'made-up-secret-keyword', minMinutes: 3, uploads: 'UUmadeupuploads', backfillToken: 'made-up-backfill', rssSeen: videoId('seen'), playlists: [{ playlist: 'PLown', rule: 'show', showName: 'Made-up own filter' }] }],
  })
  ids.picked = await creator('Made-up Picked', { videosDefault: 'picked' })
  ids.unlisted = await creator('Made-up Unlisted', { listed: false })
  ids.out = await creator('Made-up Asked Out', { doNotFeature: true })
  ids.siteB = await creator('Made-up Beta', {}, 'B')
  let n = 0
  const video = async (title: string, creatorId: string, data: Doc = {}, site = 'A') =>
    String(
      (
        await payload.create({
          collection: 'videos',
          data: { tenant: site, creator: creatorId, youtubeId: videoId(`p${++n}`), title, description: `About ${title}`, publishedAt: `2026-10-${String(10 + n).padStart(2, '0')}T00:00:00.000Z`, duration: 600 + n, thumbnail: `https://i.ytimg.com/vi/p${n}/hq.jpg`, kind: 'care', passedRules: true, source: 'api', embeddable: true, playlists: ['PLown'], hiddenReason: 'Made-up reason', ...data } as never,
        })
      ).id,
    )
  ids.care = await video('Made-up care', ids.alpha!, { species: [ids.t1], speciesState: 'approved' })
  ids.build = await video('Made-up build', ids.alpha!, { kind: 'build', species: [ids.t1], speciesState: 'review' })
  ids.hidden = await video('Made-up hidden', ids.alpha!, { passedRules: false })
  ids.gone = await video('Made-up gone', ids.alpha!, { unavailable: true })
  ids.pending = await video('Made-up pending', ids.picked!)
  ids.chosen = await video('Made-up chosen', ids.picked!, { choice: 'show', species: [ids.t2], speciesState: 'auto' })
  ids.unlistedVideo = await video('Made-up from unlisted', ids.unlisted!)
  ids.outVideo = await video('Made-up from asked out', ids.out!)
  ids.beta = await video('Made-up beta', ids.siteB!, {}, 'B')
  await payload.db.collections.videos!.updateOne({ _id: ids.care! }, { $set: { claim: 'made-up-claim' } })
})
afterAll(async () => {
  await payload.destroy()
  await stopMongo()
})

describe('the public server functions', () => {
  it('the creator list: listed creators of the visitor’s site, public fields only', async () => {
    const r = (await listCreators(await visitor('A'))) as Doc
    expect(r.creators.map((c: Doc) => c.name).sort()).toEqual(['Made-up Alpha', 'Made-up Picked'])
    const alpha = r.creators.find((c: Doc) => c.name === 'Made-up Alpha')
    expect(Object.keys(alpha).sort()).toEqual(['avatar', 'bio', 'channels', 'id', 'name', 'slug', 'website'])
    expect(alpha).toMatchObject({ slug: 'made-up-alpha', bio: 'Made-up bio', website: 'https://example.test/alpha', avatar: 'https://yt3.ggpht.com/made-up', channels: [{ handle: '@alpha', title: 'Alpha channel', channelId: channelId('alpha') }] })
    expect(Object.keys(alpha.channels[0]).sort()).toEqual(['channelId', 'handle', 'title'])
    for (const s of SECRETS) expect(JSON.stringify(r)).not.toContain(s)
  })

  it('the video grid: only what the public may see, newest first, the same for staff and admins as for a visitor', async () => {
    const seen = await listVideos(await visitor('A'))
    expect(titles(seen)).toEqual(['Made-up build', 'Made-up care', 'Made-up chosen'])
    expect((seen as Doc).videos[0].title).toBe('Made-up chosen')
    expect(Object.keys((seen as Doc).videos[0]).sort()).toEqual(['creator', 'duration', 'embeddable', 'id', 'kind', 'kindLabel', 'publishedAt', 'thumbnail', 'title', 'youtubeId'])
    expect((seen as Doc).videos[0]).toMatchObject({ kindLabel: 'Care', creator: { name: 'Made-up Picked', slug: 'made-up-picked' } })
    expect((seen as Doc).kinds.map((k: Doc) => k.value)).toEqual(['care', 'species-profile', 'build'])
    for (const p of [member, curator, staff, admin]) expect(await listVideos(await reqOf(p, 'A'))).toEqual(seen)
    expect(await listCreators(await reqOf(admin, 'A'))).toEqual(await listCreators(await visitor('A')))
    for (const s of SECRETS) expect(JSON.stringify(seen)).not.toContain(s)
  })

  it('another site sees only its own; no site sees nothing; another site’s staff see this site as a visitor does', async () => {
    expect(titles(await listVideos(await visitor('B')))).toEqual(['Made-up beta'])
    expect(titles(await listVideos(await visitor()))).toEqual([])
    expect(((await listCreators(await visitor())) as Doc).creators).toEqual([])
    expect(await getVideo(await visitor(), { youtubeId: videoId('p1') })).toMatchObject({ error: { code: 'notFound' } })
    expect(titles(await listVideos(await reqOf(staffB, 'A')))).toEqual(['Made-up build', 'Made-up care', 'Made-up chosen'])
  })

  it('the kind and topic filters, and pages; anything else in the input is refused or ignored', async () => {
    expect(titles(await listVideos(await visitor('A'), { kind: 'build' }))).toEqual(['Made-up build'])
    // Topic pages show only automatic and approved videos: the one waiting for topic review isn't there.
    expect(titles(await listVideos(await visitor('A'), { topic: ids.t1 }))).toEqual(['Made-up care'])
    expect(titles(await listVideos(await visitor('A'), { topic: ids.t2 }))).toEqual(['Made-up chosen'])
    expect(await listVideos(await visitor('A'), { kind: 'nonsense' })).toEqual({ error: { code: 'badInput', message: MESSAGES.badInput } })
    expect(await listVideos(await visitor('A'), { kind: { not_equals: 'x' } })).toMatchObject({ error: { code: 'badInput' } })
    expect(await listVideos(await visitor('A'), { topic: { exists: true } })).toMatchObject({ error: { code: 'badInput' } })
    expect(await listVideos(await visitor('A'), { topic: 'a.b' })).toMatchObject({ error: { code: 'badInput' } })
    const paged = (await listVideos(await visitor('A'), { perPage: 1, page: '2' })) as Doc
    expect(paged).toMatchObject({ page: 2, pages: 3, total: 3 })
    expect(paged.videos).toHaveLength(1)
    expect(((await listVideos(await visitor('A'), { perPage: 5000, page: -3, where: { hiddenReason: { exists: true } } } as never)) as Doc).page).toBe(1)
  })

  it('a creator’s page: unlisted, asked out, another site’s and missing all get the same answer', async () => {
    const ok = (await getCreator(await visitor('A'), { slug: 'made-up-alpha' })) as Doc
    expect(ok.creator.name).toBe('Made-up Alpha')
    expect(titles(ok)).toEqual(['Made-up build', 'Made-up care'])
    const missing = await getCreator(await visitor('A'), { slug: 'no-such-creator' })
    expect(missing).toEqual({ error: { code: 'notFound', message: MESSAGES.notFound } })
    for (const slug of ['made-up-unlisted', 'made-up-asked-out', 'made-up-beta', '', 5, { like: 'made' }, undefined]) expect(await getCreator(await visitor('A'), { slug })).toEqual(missing)
    expect(await getCreator(await reqOf(staff, 'A'), { slug: 'made-up-unlisted' })).toEqual(missing)
    expect(titles(await getCreator(await visitor('A'), { slug: 'made-up-picked' }))).toEqual(['Made-up chosen'])
  })

  it('a video’s page: hidden, gone, picked-pending, unlisted and missing all get the same answer', async () => {
    const idOf = async (id: string) => String(((await payload.findByID({ collection: 'videos', id, overrideAccess: true, depth: 0 })) as Doc).youtubeId)
    const ok = (await getVideo(await visitor('A'), { youtubeId: await idOf(ids.care!) })) as Doc
    expect(ok.video).toMatchObject({ title: 'Made-up care', description: 'About Made-up care', topics: [ids.t1], embeddable: true, creator: { name: 'Made-up Alpha' } })
    for (const s of SECRETS) expect(JSON.stringify(ok)).not.toContain(s)
    const missing = await getVideo(await visitor('A'), { youtubeId: videoId('nope') })
    expect(missing).toEqual({ error: { code: 'notFound', message: MESSAGES.notFound } })
    for (const k of ['hidden', 'gone', 'pending', 'unlistedVideo', 'outVideo', 'beta']) {
      expect(await getVideo(await visitor('A'), { youtubeId: await idOf(ids[k]!) })).toEqual(missing)
      expect(await getVideo(await reqOf(admin, 'A'), { youtubeId: await idOf(ids[k]!) })).toEqual(missing)
    }
    for (const bad of ['short', { exists: true }, undefined, '"><script>x']) expect(await getVideo(await visitor('A'), { youtubeId: bad })).toEqual(missing)
  })

  it('a stored website that isn’t an http or https link never reaches a page', async () => {
    // The field refuses these on a write; this is for a value that got into the database some other way.
    const set = (website: string | null) => payload.db.collections.creators!.updateOne({ _id: ids.picked! }, { $set: { website } })
    const seen = async () => ((await listCreators(await visitor('A'))) as Doc).creators.find((c: Doc) => c.name === 'Made-up Picked').website
    for (const bad of ['javascript:alert(1)', 'data:text/html,made-up', 'not a link', '//example.test/x']) {
      await set(bad)
      expect(await seen(), bad).toBeNull()
      expect(((await getCreator(await visitor('A'), { slug: 'made-up-picked' })) as Doc).creator.website, bad).toBeNull()
    }
    await set('http://example.test/picked')
    expect(await seen()).toBe('http://example.test/picked')
    await set(null)
  })

  it('a failure is answered in plain words, with no details', async () => {
    const broken = { payload: { config: payload.config, find: async () => Promise.reject(new Error('made-up database detail')), logger: { error: () => undefined } }, context: {}, headers: new Headers() } as unknown as PayloadRequest
    const r = await listCreators(broken)
    expect(r).toEqual({ error: { code: 'generic', message: MESSAGES.generic } })
    expect(isError(r)).toBe(true)
    expect(await listVideos({ payload: { config: { custom: {} } } } as unknown as PayloadRequest)).toMatchObject({ error: { code: 'notInstalled' } })
    expect(isError({ creators: [] })).toBe(false)
  })
})

// The site's team, 2026-11-11: the site's public pages read these, so a signed-out visitor must be able to read each and
// filter on it. Everything else stays with the site's curators and editors.
describe('the fields the site’s pages read', () => {
  const CREATOR_READS = ['name', 'slug', 'bio', 'avatar', 'website', 'channels', 'shows', 'showsDisplay', 'videosDefault']
  const VIDEO_READS = ['title', 'youtubeId', 'creator', 'publishedAt', 'duration', 'thumbnail', 'kind', 'playlists', 'species', 'speciesState']
  const HIDDEN_IN_CHANNELS = ['backfillToken', 'uploads', 'rssSeen', 'excludeKeywords', 'minMinutes', 'backfillDone', 'speciesMode', 'speciesTitles']
  const HIDDEN_ON_CREATORS = ['syncHour', 'syncDays', 'lastSyncedAt', 'lastRecheckAt', 'lastFullSyncAt', 'syncingSince', 'syncNote', 'doNotFeature', 'doNotFeatureNote']
  const HIDDEN_ON_VIDEOS = ['hiddenReason', 'ruleKey', 'locked', 'source', 'channelId', 'curation', 'passedRules', 'unavailableSince', 'claim', 'speciesNames']
  const who = (kind: string) => (kind === 'member' ? { token: tokens[member.id], site: 'A' } : { site: 'A' })

  for (const kind of ['visitor', 'member'])
    it(`a ${kind} reads each of them, over REST and the Local API, and none of the internal ones`, async () => {
      const c = (await h.rest(`/creators/${ids.alpha}?depth=0`, who(kind))).body as Doc
      for (const f of CREATOR_READS) expect(c[f], f).toBeDefined()
      expect(c).toMatchObject({ videosDefault: 'rules', showsDisplay: 'own', shows: [expect.objectContaining({ playlist: 'PLshow', name: 'Made-up show' })] })
      expect(c.channels[0]).toMatchObject({ handle: '@alpha', title: 'Alpha channel', channelId: channelId('alpha'), playlists: [expect.objectContaining({ playlist: 'PLown', showName: 'Made-up own filter' })] })
      for (const f of HIDDEN_IN_CHANNELS) expect(c.channels[0][f], `channels.${f}`).toBeUndefined()
      for (const f of HIDDEN_ON_CREATORS) expect(c[f], f).toBeUndefined()
      const v = (await h.rest(`/videos/${ids.care}?depth=0`, who(kind))).body as Doc
      for (const f of VIDEO_READS) expect(v[f], f).toBeDefined()
      expect(v).toMatchObject({ species: [ids.t1], speciesState: 'approved', playlists: ['PLown'] })
      for (const f of HIDDEN_ON_VIDEOS) expect(v[f], f).toBeUndefined()
      const local = (await payload.findByID({ collection: 'creators', id: ids.alpha!, depth: 0, ...as(kind === 'member' ? member : null, 'A') })) as Doc
      expect(local.videosDefault).toBe('rules')
      for (const f of HIDDEN_ON_CREATORS) expect(local[f], f).toBeUndefined()
      for (const s of SECRETS) expect(JSON.stringify([c, v, local])).not.toContain(s)
    })

  const creatorFilters: [string, string[]][] = [
    ['where[name][equals]=Made-up Alpha', ['Made-up Alpha']],
    ['where[slug][equals]=made-up-picked', ['Made-up Picked']],
    ['where[bio][like]=bio', ['Made-up Alpha']],
    ['where[avatar][exists]=true', ['Made-up Alpha']],
    ['where[website][like]=example.test', ['Made-up Alpha']],
    ['where[channels.handle][equals]=@alpha', ['Made-up Alpha']],
    ['where[channels.channelId][exists]=true', ['Made-up Alpha']],
    ['where[channels.playlists.showName][like]=own filter', ['Made-up Alpha']],
    ['where[shows.playlist][equals]=PLshow', ['Made-up Alpha']],
    ['where[showsDisplay][equals]=own', ['Made-up Alpha']],
    ['where[videosDefault][equals]=picked', ['Made-up Picked']],
    ['where[or][0][videosDefault][equals]=rules&where[or][1][name][equals]=x', ['Made-up Alpha']],
  ]
  for (const [q, names] of creatorFilters)
    it(`a visitor filters creators: ${q}`, async () => {
      const r = await h.rest(`/creators?${q}&depth=0`, { site: 'A' })
      expect(r.status).toBe(200)
      expect((r.body.docs as Doc[]).map((d) => d.name).sort()).toEqual(names)
    })

  const videoFilters: [string, string[]][] = [
    ['where[title][like]=care', ['Made-up care']],
    [`where[creator][equals]=ALPHA`, ['Made-up build', 'Made-up care']],
    ['where[publishedAt][greater_than]=2026-10-12T00:00:00.000Z', ['Made-up chosen']],
    ['where[duration][less_than]=602', ['Made-up care']],
    ['where[thumbnail][exists]=true', ['Made-up build', 'Made-up care', 'Made-up chosen']],
    ['where[kind][equals]=build', ['Made-up build']],
    ['where[playlists][in]=PLown', ['Made-up build', 'Made-up care', 'Made-up chosen']],
    ['where[species][in]=T1&where[speciesState][in]=auto,approved', ['Made-up care']],
    ['where[speciesState][equals]=auto', ['Made-up chosen']],
    ['where[creator.videosDefault][equals]=picked', ['Made-up chosen']],
    ['where[youtubeId][exists]=true&sort=-publishedAt', ['Made-up build', 'Made-up care', 'Made-up chosen']],
  ]
  for (const [q, names] of videoFilters)
    it(`a visitor filters videos: ${q}`, async () => {
      const r = await h.rest(`/videos?${q.replace('ALPHA', ids.alpha!).replace('T1', ids.t1!)}&depth=0`, { site: 'A' })
      expect(r.status).toBe(200)
      expect((r.body.docs as Doc[]).map((d) => d.title).sort()).toEqual(names)
    })

  const refused = [
    '/creators?where[syncHour][equals]=7',
    '/creators?where[syncDays][exists]=true',
    '/creators?where[doNotFeature][equals]=true',
    '/creators?where[channels.uploads][exists]=true',
    '/creators?where[channels.backfillToken][exists]=true',
    '/creators?where[channels.rssSeen][exists]=true',
    '/creators?where[channels.excludeKeywords][like]=secret',
    '/creators?where[channels.minMinutes][greater_than]=1',
    '/creators?where[and][0][videosDefault][equals]=rules&where[and][1][syncNote][like]=note',
    '/creators?sort=syncHour',
    '/videos?where[speciesNames][exists]=true',
    '/videos?where[hiddenReason][like]=reason',
    '/videos?where[locked][equals]=true',
    '/videos?where[creator.syncHour][equals]=7',
    '/videos?where[creator.channels.uploads][exists]=true',
    '/videos?where[or][0][creator.videosDefault][equals]=rules&where[or][1][creator.doNotFeature][equals]=true',
    '/videos?sort=-passedRules',
  ]
  for (const kind of ['visitor', 'member'])
    for (const q of refused)
      it(`a ${kind} still can’t filter or sort on an internal field: ${q}`, async () => {
        expect((await h.rest(q, who(kind))).status).toBeOneOf([400, 403])
      })
})
