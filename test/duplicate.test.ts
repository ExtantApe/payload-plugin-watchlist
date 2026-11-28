import { configToSchema } from '@payloadcms/graphql'
import { createRequire } from 'node:module'
import { createLocalReq, type CollectionBeforeOperationHook, type Config, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { playlists } from '../src/index.js'
import { as, person, scope, startPayload, stopMongo, tokenOf, videoId, type Harness, type Person } from './harness.js'

// The copy of graphql that builds Payload's schema (Node loads it as CommonJS; an import here would load a second one).
const { graphql } = createRequire(import.meta.url)('graphql') as typeof import('graphql')

// Duplicating is off for every collection the plugin adds, for everyone, server code included. Made-up data.
const SLUGS = ['creators', 'videos', 'playlists-usage'] as const
type Slug = (typeof SLUGS)[number]
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const NO_COPY = 'Playlists records can’t be duplicated. Make a new one instead.'
/** A well-formed id that no record has, and one that isn't an id at all. */
const UNKNOWN = '0123456789abcdef01234567'
const MALFORMED = 'not-an-id'

async function seed(payload: Payload) {
  const creator = String((await payload.create({ collection: 'creators', data: { tenant: 'B', name: 'Made-up source', videosDefault: 'rules', syncNote: 'Made-up note', channels: [{ handle: '@made-up' }] } as never })).id)
  const video = String((await payload.create({ collection: 'videos', data: { tenant: 'B', creator, youtubeId: videoId('source'), title: 'Made-up video', source: 'api' } as never })).id)
  const usage = String((await payload.create({ collection: 'playlists-usage', data: { day: '2026-11-01', units: 3 } as never })).id)
  return { creators: creator, videos: video, 'playlists-usage': usage } as Record<Slug, string>
}
const counts = async (payload: Payload) => Promise.all(SLUGS.map(async (collection) => (await payload.count({ collection })).totalDocs))
const refusalOf = (work: Promise<unknown>) =>
  work.then(
    () => ({ message: 'it went through', status: 200 }),
    (e: { message: string; status?: number }) => ({ message: e.message, status: e.status }),
  )

/** A GraphQL document, run against the schema Payload builds from this config. */
async function gql(payload: Payload, p: Person | null, source: string) {
  const { schema } = configToSchema(payload.config)
  const req = await createLocalReq({ user: p ? (p as never) : undefined }, payload)
  return graphql({ schema, source, contextValue: { req, headers: new Headers() } })
}
const mutationsOf = (payload: Payload) => Object.keys(configToSchema(payload.config).schema.getMutationType()!.getFields())

afterAll(stopMongo)

describe('duplicating is off', () => {
  let h: Harness
  let payload: Payload
  let ids: Record<Slug, string>
  const people: Record<string, Person> = {}
  const tokens: Record<string, string> = {}

  beforeAll(async () => {
    h = await startPayload()
    payload = h.payload
    people.member = await person(payload, 'A')
    people.curator = await person(payload, 'B', 'curator')
    people.editorA = await person(payload, 'A', 'staff')
    people.editorB = await person(payload, 'B', 'staff')
    people.admin = await person(payload, 'A', 'admin')
    for (const [k, p] of Object.entries(people)) tokens[k] = await tokenOf(payload, p)
    ids = await seed(payload)
  })
  afterAll(async () => {
    await payload.destroy()
  })

  const everyone = () => [null, ...Object.values(people)]

  it('every collection the plugin adds sets disableDuplicate', () => {
    for (const slug of SLUGS) expect(payload.collections[slug]!.config.disableDuplicate).toBe(true)
  })

  it('payload.duplicate is refused for everyone, server code included', async () => {
    const before = await counts(payload)
    for (const slug of SLUGS) {
      await expect(payload.duplicate({ collection: slug, id: ids[slug] })).rejects.toThrow('cannot be duplicated')
      for (const p of everyone()) await expect(payload.duplicate({ collection: slug, id: ids[slug], data: { tenant: 'A' } as never, ...as(p, 'B') } as never)).rejects.toThrow('cannot be duplicated')
    }
    expect(await counts(payload)).toEqual(before)
  })

  it('a create with duplicateFromID gets one answer for a real, unknown or malformed id, from everyone', async () => {
    const before = await counts(payload)
    for (const slug of SLUGS)
      for (const duplicateFromID of [ids[slug], UNKNOWN, MALFORMED, '', 0]) {
        const data = { tenant: 'A' } as never
        expect(await refusalOf(payload.create({ collection: slug, data, duplicateFromID } as never))).toEqual({ message: NO_COPY, status: 403 })
        for (const p of everyone()) expect(await refusalOf(payload.create({ collection: slug, data, duplicateFromID, ...as(p, 'B') } as never))).toEqual({ message: NO_COPY, status: 403 })
      }
    expect(await counts(payload)).toEqual(before)
  })

  it('REST has no duplicate route', async () => {
    const before = await counts(payload)
    for (const slug of SLUGS)
      for (const id of [ids[slug], UNKNOWN, MALFORMED])
        for (const who of ['editorA', 'editorB', 'admin']) {
          const r = await h.rest(`/${slug}/${id}/duplicate`, { method: 'POST', token: tokens[who], site: 'B', body: { tenant: 'A' } })
          expect(r.status).toBe(404)
          expect(r.body.message).toContain('Route not found')
        }
    expect(await counts(payload)).toEqual(before)
  })

  it('GraphQL has no duplicate mutation, and keeps create', () => {
    const names = mutationsOf(payload)
    expect(names).toContain('createCreator')
    expect(names).toContain('createVideo')
    expect(names.filter((n) => n.startsWith('duplicate') && !n.startsWith('duplicatePayload'))).toEqual([])
  })

  it('an editor still creates a creator and a video on their own site: Local API, REST and GraphQL', async () => {
    const local = (await payload.create({ collection: 'creators', data: { tenant: 'A', name: 'Made-up local', channels: [{ handle: '@local' }] } as never, ...as(people.editorA!, 'A') })) as Doc
    expect(local.tenant).toBe('A')
    const rest = await h.rest('/creators', { method: 'POST', token: tokens.editorA, body: { tenant: 'A', name: 'Made-up rest', channels: [{ handle: '@rest' }] } })
    expect(rest.status).toBe(201)
    const video = await h.rest('/videos', { method: 'POST', token: tokens.editorA, body: { tenant: 'A', creator: rest.body.doc.id, youtubeId: videoId('restmade'), title: 'Made-up rest video' } })
    expect(video.status).toBe(201)
    const onSite = await gql(payload, people.editorA!, 'mutation { createCreator(data: { tenant: "A", name: "Made-up graph", slug: "made-up-graph", channels: [{ handle: "@graph" }] }) { id name } }')
    expect(onSite.errors).toBeUndefined()
    expect((onSite.data as Doc).createCreator.name).toBe('Made-up graph')
  })

  it('server code still creates without a person', async () => {
    const doc = (await payload.create({ collection: 'creators', data: { tenant: 'B', name: 'Made-up server', channels: [{ handle: '@server' }] } as never })) as Doc
    expect(doc.id).toBeTruthy()
  })

  it('an ordinary create is refused for anyone who doesn’t edit that site', async () => {
    const before = await counts(payload)
    const bodies: Record<Slug, Doc> = {
      creators: { tenant: 'A', name: 'Made-up direct', channels: [{ handle: '@direct', excludeKeywords: 'made-up', backfillToken: 'made-up' }], syncNote: 'made-up', doNotFeatureNote: 'made-up' },
      videos: { tenant: 'B', creator: ids.creators, youtubeId: videoId('direct'), title: 'Made-up direct', hiddenReason: 'made-up', claim: 'made-up', source: 'api', passedRules: true },
      'playlists-usage': { day: '2026-11-02', units: 1 },
    }
    for (const slug of SLUGS) {
      // The video is for site B, where the curator curates; the creator is for site A, which editorB doesn't edit.
      const refused = [null, people.member!, people.curator!, ...(slug === 'videos' ? [people.editorA!] : [people.editorB!])]
      for (const p of refused) {
        await expect(payload.create({ collection: slug, data: bodies[slug] as never, ...as(p, 'B') })).rejects.toThrow(/not allowed/)
        const key = Object.keys(people).find((k) => people[k] === p)
        const r = await h.rest(`/${slug}`, { method: 'POST', token: key ? tokens[key] : undefined, site: 'B', body: bodies[slug] })
        expect(r.status).toBe(403)
      }
    }
    // Nobody creates a unit ledger row through access, an admin included.
    await expect(payload.create({ collection: 'playlists-usage', data: bodies['playlists-usage'] as never, ...as(people.admin!, 'A') })).rejects.toThrow(/not allowed/)
    expect(await counts(payload)).toEqual(before)
  })
})

describe('duplicating stays off when the site’s config turns it back on', () => {
  let payload: Payload
  let h: Harness
  let ids: Record<Slug, string>
  let admin: Person
  let token = ''
  let hostInit = false
  /** When set, a hook added after the plugin turns an ordinary create into a duplicate of this id. */
  let slipIn: string | null = null
  const lateHook: CollectionBeforeOperationHook = ({ args, operation }) => (operation === 'create' && slipIn ? { ...args, duplicateFromID: slipIn } : args)
  const on = (c: Doc) => ({ ...c, disableDuplicate: false })

  beforeAll(async () => {
    const later = (config: Config): Config => ({
      ...config,
      collections: (config.collections ?? []).map((c) =>
        (SLUGS as readonly string[]).includes(c.slug) ? { ...c, disableDuplicate: false, hooks: { ...c.hooks, beforeOperation: [...(c.hooks?.beforeOperation ?? []), lateHook] } } : c,
      ),
    })
    h = await startPayload((o) => ({ ...o, overrides: { creators: on as never, videos: on as never, usage: on as never } }), {
      plugins: [later],
      onInit: async () => {
        hostInit = true
      },
    })
    payload = h.payload
    admin = await person(payload, 'A', 'admin')
    token = await tokenOf(payload, admin)
    ids = await seed(payload)
  })
  afterAll(async () => {
    await payload.destroy()
  })

  it('disableDuplicate is on again after startup, and the site’s own onInit still ran', () => {
    expect(hostInit).toBe(true)
    for (const slug of SLUGS) expect(payload.collections[slug]!.config.disableDuplicate).toBe(true)
  })

  it('a later hook that sets duplicateFromID on a create is refused', async () => {
    const before = await counts(payload)
    for (const slug of SLUGS)
      for (const id of [ids[slug], UNKNOWN]) {
        slipIn = id
        try {
          expect(await refusalOf(payload.create({ collection: slug, data: { tenant: 'A' } as never }))).toEqual({ message: NO_COPY, status: 403 })
        } finally {
          slipIn = null
        }
      }
    expect(await counts(payload)).toEqual(before)
  })

  it('with the flag off while running, Local API, REST and GraphQL are all still refused', async () => {
    const before = await counts(payload)
    for (const slug of SLUGS) payload.collections[slug]!.config.disableDuplicate = false
    try {
      // Each mutation with the arguments GraphQL asks for.
      const mutations: Record<Slug, [string, string]> = {
        creators: ['duplicateCreator', '{ name: "Made-up", slug: "made-up" }'],
        videos: ['duplicateVideo', `{ title: "Made-up", youtubeId: "${videoId('graphdup')}" }`],
        'playlists-usage': ['duplicatePlaylistsUsage', '{ day: "2026-11-03" }'],
      }
      for (const slug of SLUGS)
        for (const id of [ids[slug], UNKNOWN, MALFORMED]) {
          expect(await refusalOf(payload.duplicate({ collection: slug, id }))).toEqual({ message: NO_COPY, status: 403 })
          expect(await refusalOf(payload.duplicate({ collection: slug, id, ...as(admin, 'A') } as never))).toEqual({ message: NO_COPY, status: 403 })
          // The route is there in this build, because a later plugin had the flag off while Payload built it.
          const r = await h.rest(`/${slug}/${id}/duplicate`, { method: 'POST', token, body: { tenant: 'A' } })
          expect(r.status).toBe(403)
          expect(r.body.errors).toEqual([expect.objectContaining({ message: NO_COPY })])
          const g = await gql(payload, admin, `mutation { ${mutations[slug][0]}(id: "${id}", data: ${mutations[slug][1]}) { id } }`)
          expect(g.errors?.map((e) => e.message)).toEqual([NO_COPY])
        }
    } finally {
      for (const slug of SLUGS) payload.collections[slug]!.config.disableDuplicate = true
    }
    expect(await counts(payload)).toEqual(before)
  })
})

describe('overrides', () => {
  it('can’t turn duplicating on', async () => {
    const on = (c: Doc) => ({ ...c, disableDuplicate: false })
    const built = await playlists({ scope, enabled: () => true, overrides: { creators: on as never, videos: on as never, usage: on as never } })({ collections: [] } as never)
    expect(built.collections!.map((c) => [c.slug, c.disableDuplicate])).toEqual(SLUGS.map((s) => [s, true]))
  })
})
