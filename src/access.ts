import { Forbidden, type Access, type CollectionBeforeOperationHook, type FieldAccess, type PayloadRequest, type Where } from 'payload'

import type { ResolvedOptions, SiteId } from './types.js'

/**
 * Only an answer of exactly `true` passes. Anything else is a no: `false`, a truthy value such as `1`, `'true'` or
 * `{}`, a promise of one of those, and an error thrown or rejected (so a broken check refuses, never a 500).
 */
export async function exactlyTrue(check: () => unknown): Promise<boolean> {
  try {
    return (await check()) === true
  } catch {
    return false
  }
}

const isSite = (v: unknown): v is SiteId => (typeof v === 'string' && v.length > 0) || (typeof v === 'number' && Number.isFinite(v))

/** The sites a person holds a role on. Anything but an array of ids, or a throw, is none. */
export async function sitesFor(o: ResolvedOptions, req: PayloadRequest, role: 'curate' | 'edit'): Promise<SiteId[]> {
  try {
    const list = await o.scope.sitesFor(req, role)
    return Array.isArray(list) ? list.filter(isSite) : []
  } catch {
    return []
  }
}

/** The visitor's site, or null. Anything but a string or a number, or a throw, is null. */
export async function siteOf(o: ResolvedOptions, req: PayloadRequest): Promise<SiteId | null> {
  if (typeof o.scope.ofRequest !== 'function') return null
  try {
    const site = await o.scope.ofRequest(req)
    return isSite(site) ? site : null
  } catch {
    return null
  }
}

/** One answer per request for each question: field access asks for every field of every record. */
const memo = new WeakMap<object, Map<string, Promise<unknown>>>()
function once<T>(req: PayloadRequest, key: string, fn: () => Promise<T>): Promise<T> {
  if (!req || typeof req !== 'object') return fn()
  let m = memo.get(req)
  if (!m) memo.set(req, (m = new Map()))
  if (!m.has(key)) m.set(key, fn())
  return m.get(key) as Promise<T>
}

export const isAdmin = (o: ResolvedOptions, req: PayloadRequest) => once(req, 'admin', () => exactlyTrue(() => o.scope.isAdmin(req)))

/** Editors may curate too. */
export function curateSites(o: ResolvedOptions, req: PayloadRequest): Promise<SiteId[]> {
  return once(req, 'curate', async () => {
    const [c, e] = [await sitesFor(o, req, 'curate'), await sitesFor(o, req, 'edit')]
    return [...new Set([...c, ...e])]
  })
}

export const editSites = (o: ResolvedOptions, req: PayloadRequest) => once(req, 'edit', () => sitesFor(o, req, 'edit'))

/** Where a person's sites are: a list of sites as a query, `true` without scope, false when they hold none. */
function onSites(o: ResolvedOptions, sites: SiteId[]): Where | boolean {
  if (!sites.length) return false
  if (!o.scope.field) return true
  return { [o.scope.field]: { in: sites } }
}

/** True when `site` is one of `sites` (or there's no scope and the list isn't empty). */
export const holds = (o: ResolvedOptions, sites: SiteId[], site: unknown): boolean =>
  sites.length > 0 && (!o.scope.field || sites.some((s) => String(s) === String(idOf(site))))

export const idOf = (v: unknown): string | null => (v && typeof v === 'object' ? String((v as { id: unknown }).id) : v || v === 0 ? String(v) : null)

/** Combine a list of access answers with OR, dropping refusals. */
function anyOf(parts: (Where | boolean)[]): Where | boolean {
  if (parts.some((p) => p === true)) return true
  const wheres = parts.filter((p): p is Where => typeof p === 'object' && p !== null)
  if (!wheres.length) return false
  return wheres.length === 1 ? wheres[0]! : { or: wheres }
}

/**
 * What the public may read, for a site (or every site without scope). Visitors and signed-in people with no role on
 * the site get only this. Fails closed: with scope and no site, nothing.
 */
async function publicPart(o: ResolvedOptions, req: PayloadRequest, visible: Where[], viaCreator = false): Promise<Where | false> {
  if (!o.scope.field) return { and: visible }
  const site = await siteOf(o, req)
  if (site === null) return false
  // A video shows on a site only when its creator is of that site too.
  const creatorSite: Where[] = viaCreator ? [{ [`creator.${o.scope.field}`]: { equals: site } }] : []
  return { and: [...visible, { [o.scope.field]: { equals: site } }, ...creatorSite] }
}

/** Creators the public may see: listed and not asked to be left out. */
export const publicCreatorWhere = (): Where[] => [{ listed: { equals: true } }, { doNotFeature: { not_equals: true } }]

/**
 * Videos the public may see: shown, not gone, from a listed creator who hasn't asked to be left out, and either a
 * curator's "Always show" or a creator whose videos show by the rules. A missing or unknown curation counts as
 * "picked", so it never passes on its own.
 */
export function publicVideoWhere(o: ResolvedOptions): Where[] {
  const byRules: Where =
    o.curationLevel === 'creator' ? { and: [{ curation: { equals: 'rules' } }, { 'creator.videosDefault': { equals: 'rules' } }] } : { curation: { equals: 'rules' } }
  return [
    { shown: { equals: true } },
    { unavailable: { not_equals: true } },
    { 'creator.listed': { equals: true } },
    { 'creator.doNotFeature': { not_equals: true } },
    { or: [{ choice: { equals: 'show' } }, byRules] },
  ]
}

export function readCreators(o: ResolvedOptions): Access {
  return async ({ req }) => {
    if (await isAdmin(o, req)) return true
    return anyOf([await publicPart(o, req, publicCreatorWhere()), onSites(o, await curateSites(o, req))])
  }
}

export function readVideos(o: ResolvedOptions): Access {
  return async ({ req }) => {
    if (await isAdmin(o, req)) return true
    return anyOf([await publicPart(o, req, publicVideoWhere(o), true), onSites(o, await curateSites(o, req))])
  }
}

/** Editors of a site, or an admin. */
export function editAccess(o: ResolvedOptions): Access {
  return async ({ req }) => {
    if (await isAdmin(o, req)) return true
    return onSites(o, await editSites(o, req))
  }
}

/** Create: an editor somewhere (the site written is checked in a hook), or an admin. */
export function createAccess(o: ResolvedOptions): Access {
  return async ({ req }) => (await isAdmin(o, req)) || (await editSites(o, req)).length > 0
}

/** Curators and editors of the video's site, or an admin. What a curator may change is narrowed by a hook. */
export function curateAccess(o: ResolvedOptions): Access {
  return async ({ req }) => {
    if (await isAdmin(o, req)) return true
    return onSites(o, await curateSites(o, req))
  }
}

export const adminOnly =
  (o: ResolvedOptions): Access =>
  ({ req }) =>
    isAdmin(o, req)

export const nobody: Access = () => false

// ---------------------------------------------------------------- internal fields

/**
 * Read access for a field that isn't for the public: only an admin, or a curator or editor of the record's own site.
 * Without a record (Payload asking whether a filter may use the field), anyone with a role passes here; the query
 * guard below then keeps their filter to their own sites.
 */
export function staffField(o: ResolvedOptions, role: 'curate' | 'edit' | 'admin' = 'curate'): FieldAccess {
  return async ({ req, doc }) => {
    if (await isAdmin(o, req)) return true
    if (role === 'admin') return false
    const sites = role === 'edit' ? await editSites(o, req) : await curateSites(o, req)
    if (!doc) return sites.length > 0
    return holds(o, sites, o.scope.field ? (doc as Record<string, unknown>)[o.scope.field] : null)
  }
}

/** Every key a Where uses, `and` and `or` included, at any depth. */
export function pathsOf(where: unknown, out: string[] = []): string[] {
  if (!where || typeof where !== 'object') return out
  if (Array.isArray(where)) {
    for (const w of where) pathsOf(w, out)
    return out
  }
  for (const [k, v] of Object.entries(where as Record<string, unknown>)) {
    if (k === 'and' || k === 'or') pathsOf(v, out)
    else out.push(k)
  }
  return out
}

export type InternalPaths = { own: string[]; related?: Record<string, string[]> }

/** True when a query path names an internal field, here or through a relationship (`creator.syncNote`). */
export function touchesInternal(path: string, internal: InternalPaths): boolean {
  const clean = path.replace(/^-/, '').replace(/\.(equals|in|exists|like|contains|not_equals|not_in)$/, '')
  const top = clean.split('.')[0]!
  if (internal.own.some((f) => clean === f || clean.startsWith(`${f}.`) || top === f)) return true
  for (const [rel, fields] of Object.entries(internal.related ?? {}))
    if (top === rel) {
      const rest = clean.slice(rel.length + 1)
      if (fields.some((f) => rest === f || rest.startsWith(`${f}.`))) return true
    }
  return false
}

/**
 * The query guard: a filter, sort or distinct read that uses an internal field is refused for anyone without a role,
 * and kept to their own sites for a curator or editor. An admin is left alone.
 */
export function queryGuard(o: ResolvedOptions, internal: InternalPaths, role: 'curate' | 'edit' | 'admin' = 'curate'): CollectionBeforeOperationHook {
  return async ({ args, operation, req }) => {
    if (!['read', 'count', 'readDistinct'].includes(operation)) return args
    const a = args as { where?: Where; sort?: string | string[]; field?: string; overrideAccess?: boolean }
    if (a.overrideAccess === true) return args
    const sorts = (Array.isArray(a.sort) ? a.sort : typeof a.sort === 'string' ? a.sort.split(',') : []).map((x) => x.trim()).filter(Boolean)
    const used = [...pathsOf(a.where), ...sorts, ...(typeof a.field === 'string' ? [a.field] : [])]
    if (!used.some((p) => touchesInternal(p, internal))) return args
    if (await isAdmin(o, req)) return args
    const sites = role === 'admin' ? [] : role === 'edit' ? await editSites(o, req) : await curateSites(o, req)
    if (!sites.length) throw new Forbidden(req.t)
    if (o.scope.field) a.where = a.where && Object.keys(a.where).length ? { and: [a.where, { [o.scope.field]: { in: sites } }] } : { [o.scope.field]: { in: sites } }
    return args
  }
}
