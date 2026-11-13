import { APIError, createLocalReq, type Payload, type PayloadRequest } from 'payload'

import { editSites, holds, isAdmin } from './access.js'
import { sendReviewDigest } from './curation.js'
import { optionsOf, syncCreator, type SyncReport } from './sync.js'

const refuse = (message: string, status: number, data?: Record<string, unknown>) => new APIError(message, status, data, true)

/** "in 7 minutes", "in 1 minute", "in under a minute". */
const inWords = (ms: number) => {
  const m = Math.ceil(ms / 60_000)
  return ms < 60_000 ? 'in under a minute' : `in ${m} minute${m === 1 ? '' : 's'}`
}

/**
 * Sync now, for one creator, asked for by a person: an editor of the creator's site, or an admin. It reads the creator
 * in full and re-checks its stored videos, through the same unit ledger and daily cap as every other run, and holds the
 * same atomic run lock, so a second click (or the cron) while one is going gets a 409 and starts nothing.
 *
 * Signed out: 401. No editor role anywhere: 403. A creator that doesn't exist and one on a site the person doesn't edit
 * get the same 404. A creator synced in the last `syncNow.cooldownMinutes` (10 by default), by anyone or by the cron,
 * gets a 429 that says when to try again (`retryAfter`, in seconds). With `youtube.siteDailyUnitCap`, the run also stays
 * inside its site's share of the day's units. It stores nothing of its own: the cooldown reads `lastSyncedAt`.
 */
export async function syncNow(payload: Payload, args: { req: PayloadRequest; id: string; now?: Date }): Promise<SyncReport> {
  const o = optionsOf(payload)
  const { req } = args
  const id = String(args.id ?? '')
  if (!req?.user) throw refuse('Sign in first.', 401)
  const admin = await isAdmin(o, req)
  const sites = admin ? [] : await editSites(o, req)
  if (!admin && !sites.length) throw refuse('Sync now is for the site’s editors.', 403)
  const creator = /^[a-f0-9]{24}$/i.test(id)
    ? ((await payload.findByID({ collection: o.collections.creators, id, depth: 0, overrideAccess: true, disableErrors: true, select: { lastSyncedAt: true, ...(o.scope.field ? { [o.scope.field]: true } : {}) } as never })) as Record<string, unknown> | null)
    : null
  if (!creator || (!admin && !holds(o, sites, o.scope.field ? creator[o.scope.field] : null))) throw refuse('No such creator.', 404)
  // The cooldown: a creator rests after any sync, so repeated clicks can't spend the day's units. Admins wait too.
  const now = args.now ?? new Date()
  const last = typeof creator.lastSyncedAt === 'string' ? new Date(creator.lastSyncedAt).getTime() : NaN
  const wait = Number.isNaN(last) ? 0 : last + o.syncNowCooldownMs - now.getTime()
  if (wait > 0) throw refuse(`This creator was synced a moment ago. Try again ${inWords(wait)}.`, 429, { retryAfter: Math.ceil(wait / 1000) })
  // The sync writes as the plugin, on a request of its own, so the person's request isn't marked as a sync.
  const run = await createLocalReq({ user: req.user }, payload)
  const report = await syncCreator(payload, id, { full: true, recheck: true, req: run, now })
  if (report.skipped === 'busy') throw refuse('This creator is syncing already. Try again in a few minutes.', 409)
  if (report.skipped === 'disabled') throw refuse('Syncing is off here: outside connections aren’t allowed.', 400)
  if (report.skipped === 'do-not-feature') throw refuse('This creator asked not to be featured, so it isn’t synced.', 400)
  if (report.skipped) throw refuse('No such creator.', 404)
  if (o.revalidate && (report.added || report.updated))
    for (const tag of ['videos', 'creators'] as const)
      try {
        o.revalidate({ site: report.site, tag })
      } catch {
        // the site's cache
      }
  if (report.added > 0) await sendReviewDigest(payload, { mode: 'urgent', sites: [report.site], req: run, now }).catch(() => undefined)
  return report
}
