import { createLocalReq, Forbidden, NotFound, APIError, type Payload, type PayloadRequest, type Where } from 'payload'
import { randomUUID } from 'node:crypto'

import { curateSites, exactlyTrue, holds, idOf, isAdmin } from './access.js'
import { AlreadyDecided } from './errors.js'
import { ledger } from './ledger.js'
import { optionsOf } from './sync.js'
import type { ResolvedOptions, SiteId } from './types.js'

export { AlreadyDecided }

/**
 * A curator's yes or no on a waiting video, from the review queue. One atomic claim on the video comes first, so two
 * curators acting at once can't both decide: the second gets `AlreadyDecided`. The decision itself is then written with
 * the curator's own access (`overrideAccess: false`), so every access rule and hook applies. If that write fails, the
 * claim is let go.
 */
export async function reviewVideo(payload: Payload, args: { req: PayloadRequest; id: string; choice: 'show' | 'hide' }): Promise<{ id: string; choice: 'show' | 'hide'; shown: boolean }> {
  const o = optionsOf(payload)
  const { req, id, choice } = args
  if (choice !== 'show' && choice !== 'hide') throw new APIError('A choice is "show" or "hide".', 400, undefined, true)
  if (!req?.user) throw new APIError('Sign in first.', 401, undefined, true)
  // The curator must be able to see and update the video; this read uses their access.
  const video = (await payload.findByID({ collection: o.collections.videos, id, depth: 0, overrideAccess: false, user: req.user, req, disableErrors: true })) as Record<string, unknown> | null
  if (!video) throw new NotFound(req.t)
  const admin = await isAdmin(o, req)
  if (!admin && !holds(o, await curateSites(o, req), o.scope.field ? video[o.scope.field] : null)) throw new Forbidden(req.t)
  const model = (payload.db as unknown as { collections: Record<string, { updateOne: (f: object, u: object) => Promise<{ modifiedCount: number }> }> }).collections[o.collections.videos]
  if (!model?.updateOne) throw new Error('Watchlist: review claims need MongoDB.')
  const token = `${idOf(req.user)}:${randomUUID()}`
  const free = [{ $or: [{ choice: null }, { choice: { $exists: false } }] }, { $or: [{ claim: null }, { claim: { $exists: false } }] }]
  const won = await model.updateOne({ _id: id, $and: free }, { $set: { claim: token } })
  if (won.modifiedCount !== 1) throw new AlreadyDecided()
  try {
    const doc = (await payload.update({ collection: o.collections.videos, id, data: { choice } as never, overrideAccess: false, user: req.user, req, depth: 0 })) as unknown as { shown: boolean }
    return { id, choice, shown: doc.shown === true }
  } catch (error) {
    await model.updateOne({ _id: id, claim: token }, { $set: { claim: null } })
    throw error
  }
}

/**
 * What waits for a curator: no choice yet, not gone, from a listed creator who hasn't asked to be left out, and either
 * passed the rules under a "picked" creator, or came from the feed only (unchecked by the rules). `sites` keeps it to
 * one site, or a list of them; `null` is every site.
 */
export function waitingWhere(sites: SiteId | SiteId[] | null, o: ResolvedOptions): Where {
  const and: Where[] = [
    { or: [{ choice: { exists: false } }, { choice: { equals: null } }] },
    { unavailable: { not_equals: true } },
    { shown: { not_equals: true } },
    { 'creator.listed': { equals: true } },
    { 'creator.doNotFeature': { not_equals: true } },
    { or: [{ and: [{ passedRules: { equals: true } }, { curation: { not_equals: 'rules' } }] }, { source: { equals: 'rss' } }] },
  ]
  if (o.scope.field && sites !== null) and.push({ [o.scope.field]: Array.isArray(sites) ? { in: sites } : { equals: sites } })
  return { and }
}

/** Every waiting video of a site, counted by the plugin itself (the digest). Not for a person's request: no access check. */
export async function countWaiting(payload: Payload, site: SiteId | SiteId[] | null = null): Promise<number> {
  const o = optionsOf(payload)
  const { totalDocs } = await payload.count({ collection: o.collections.videos, where: waitingWhere(site, o), overrideAccess: true })
  return totalDocs
}

/**
 * Whose queue a person may see: every site for an admin, the sites they curate or edit otherwise, and `null` for anyone
 * else (signed out, a member, a provider that answers anything but what's asked). `site` narrows it to one of those.
 */
export async function queueSitesOf(o: ResolvedOptions, req: PayloadRequest, site?: SiteId | null): Promise<{ sites: SiteId[] | null } | null> {
  if (!req?.user) return null
  if (await isAdmin(o, req)) return { sites: site === undefined || site === null || !o.scope.field ? null : [site] }
  const mine = await curateSites(o, req)
  if (!mine.length) return null
  if (!o.scope.field) return { sites: null }
  if (site === undefined || site === null) return { sites: mine }
  return holds(o, mine, site) ? { sites: [site] } : null
}

/**
 * How many videos wait for this person's yes, for the site's dashboard: the sites they curate (every site for an
 * admin), or one of them with `site`. Anyone else (signed out, a member, another site's staff asking for this site)
 * gets 0, and no query is run for them.
 */
export async function reviewQueueCount(payload: Payload, args: { req: PayloadRequest; site?: SiteId | null }): Promise<number> {
  const o = optionsOf(payload)
  const who = await queueSitesOf(o, args?.req, args?.site)
  if (!who) return 0
  return countWaiting(payload, who.sites)
}

export type DigestReport = { site: SiteId | null; waiting: number; sent: 'daily' | 'urgent' | null; failed?: true }[]

/**
 * The curators' digest (Site lead, 2026-11-11): one a day per site when videos wait (nothing when the queue is empty),
 * and one at once when more than `curation.urgentAt` (25) wait. Each goes at most once a day, and the daily one stands
 * down when the urgent one already went that day. Sent through `notify` only when outside calls are allowed; without
 * `notify`, the admin's queue count is all there is. A send that fails gives its claim back, so the next run tries again.
 *
 * `mode: 'daily'` from the site's daily cron. `mode: 'urgent'` runs by itself after `syncDue` and Sync now.
 */
export async function sendReviewDigest(payload: Payload, opts: { mode: 'daily' | 'urgent'; sites?: (SiteId | null)[]; now?: Date; req?: PayloadRequest }): Promise<DigestReport> {
  const o = optionsOf(payload)
  const req = opts.req ?? (await createLocalReq({}, payload))
  const now = opts.now ?? new Date()
  const book = ledger(payload, o, () => now)
  const sites = opts.sites ?? (await sitesWithCreators(payload, o))
  const enabled = await exactlyTrue(() => o.enabled(req))
  const out: DigestReport = []
  for (const site of sites) {
    const waiting = await countWaiting(payload, site)
    let sent: 'daily' | 'urgent' | null = null
    let failed = false
    const due = opts.mode === 'daily' ? waiting > 0 : waiting > o.urgentAt
    if (due && enabled && o.notify && (await book.claimDigest(site, opts.mode))) {
      try {
        await o.notify({ kind: 'watchlist.review', site, waiting, urgent: opts.mode === 'urgent' }, { req })
        sent = opts.mode
      } catch {
        failed = true
        await book.releaseDigest(site, opts.mode)
      }
    }
    out.push({ site, waiting, sent, ...(failed ? { failed: true as const } : {}) })
  }
  return out
}

async function sitesWithCreators(payload: Payload, o: ResolvedOptions): Promise<(SiteId | null)[]> {
  if (!o.scope.field) return [null]
  const { docs } = await payload.find({ collection: o.collections.creators, depth: 0, pagination: false, overrideAccess: true, select: { [o.scope.field]: true } as never })
  return [...new Set(docs.map((d) => idOf((d as Record<string, unknown>)[o.scope.field!])).filter((s): s is string => s !== null))]
}
