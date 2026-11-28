import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, handleEndpoints, type Config, type Payload, type PayloadRequest } from 'payload'

import { playlists, type PlaylistsOptions, type ResolvedOptions } from '../src/index.js'

/**
 * Payload on an in-memory MongoDB replica set, with made-up people on two made-up sites (A and B). Each person has a
 * `site` and maybe a `role` (curator, staff, admin). A small plugin after Playlists adds a `tenant` field, as a site's
 * multi-tenant plugin would. A visitor's site comes from `req.context.site` (Local API) or an `x-site` header (REST).
 * Never a network call: the global fetch throws (test/setup.ts), and YouTube is a fake passed in.
 */

let mongo: MongoMemoryReplSet | null = null
let n = 0

export async function startMongo() {
  mongo ??= await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  return mongo
}
export async function stopMongo() {
  await mongo?.stop()
  mongo = null
}

type U = { site?: string; role?: string } | null | undefined
const userOf = (req: PayloadRequest) => req.user as U

export const scope: PlaylistsOptions['scope'] = {
  field: 'tenant',
  ofRequest: (req) => {
    const fromContext = (req.context as { site?: string } | undefined)?.site
    if (fromContext) return fromContext
    const header = req.headers?.get?.('x-site')
    if (header) return header
    return userOf(req)?.site ?? null
  },
  sitesFor: (req, role) => {
    const u = userOf(req)
    if (!u?.site) return []
    if (u.role === 'staff') return [u.site]
    if (u.role === 'curator' && role === 'curate') return [u.site]
    return []
  },
  isAdmin: (req) => userOf(req)?.role === 'admin',
}

const addTenantField = (config: Config): Config => ({
  ...config,
  collections: (config.collections ?? []).map((c) => (['creators', 'videos'].includes(c.slug) ? { ...c, fields: [...c.fields, { name: 'tenant', type: 'text', index: true }] } : c)),
})

export const KINDS = [
  { label: 'Care', value: 'care' },
  { label: 'Species profile', value: 'species-profile' },
  { label: 'Build', value: 'build' },
  { label: 'Vlog', value: 'vlog' },
]

export type Harness = { payload: Payload; key: string; rest: (path: string, init?: { method?: string; body?: unknown; token?: string; site?: string }) => Promise<{ status: number; body: any }> } // eslint-disable-line @typescript-eslint/no-explicit-any

export async function startPayload(change: (o: PlaylistsOptions) => PlaylistsOptions = (o) => o, extra: Partial<Config> = {}): Promise<Harness> {
  const m = await startMongo()
  const options = change({ scope, enabled: () => true, kinds: KINDS, shownKinds: ['care', 'species-profile', 'build'], topicKinds: ['care', 'species-profile'] })
  const key = `playlists-${++n}`
  const payload = await getPayload({
    key,
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: m.getUri(key), ensureIndexes: true }),
      collections: [{ slug: 'users', auth: true, fields: [{ name: 'site', type: 'text' }, { name: 'role', type: 'select', options: ['curator', 'staff', 'admin'] }] }, ...(extra.collections ?? [])],
      plugins: [playlists(options), addTenantField, ...(extra.plugins ?? [])],
      ...(extra.onInit ? { onInit: extra.onInit } : {}),
    }),
  } as never)
  const db = payload.db as unknown as { collections: Record<string, { ensureIndexes: () => Promise<void> }> }
  const { collections } = (payload.config.custom as { playlists: ResolvedOptions }).playlists
  await Promise.all(Object.values(collections).map((c) => db.collections[c]!.ensureIndexes()))
  const rest: Harness['rest'] = async (path, init = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (init.token) headers.Authorization = `JWT ${init.token}`
    if (init.site) headers['x-site'] = init.site
    const res = await handleEndpoints({
      config: Promise.resolve(payload.config),
      payloadInstanceCacheKey: key,
      request: new Request(`http://localhost/api${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }),
    } as never)
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  return { payload, key, rest }
}

let people = 0
export type Person = { id: string; email: string; password: string; site: string; role?: string; collection: 'users' }
export async function person(payload: Payload, site: string, role?: 'curator' | 'staff' | 'admin'): Promise<Person> {
  const i = ++people
  const password = `made-up-password-${i}`
  const doc = (await payload.create({ collection: 'users', data: { email: `person-${i}@example.test`, password, site, role } as never })) as unknown as Person
  return { ...doc, password, collection: 'users' }
}
export async function tokenOf(payload: Payload, p: Person) {
  return (await payload.login({ collection: 'users', data: { email: p.email, password: p.password } })).token!
}

/** Local API as a person (or a signed-out visitor of `site`), with access checked. */
export const as = (p: Person | null, site?: string) => ({ overrideAccess: false as const, user: p ? (p as never) : undefined, context: site ? { site } : {} })

/** A made-up channel ID (UC + 22). */
export const channelId = (s: string) => `UC${s.padEnd(22, 'x').slice(0, 22)}`
/** A made-up video ID (11 characters). */
export const videoId = (s: string) => s.padEnd(11, '_').slice(0, 11)
