import type { Payload } from 'payload'

import type { ResolvedOptions, SiteId } from './types.js'

/**
 * The unit ledger: one `playlists-usage` record a day (in the zone YouTube's quota resets in), counting the Data API
 * units spent across every site, and whether a quota error stopped the day. Every API call reserves its units first,
 * with one atomic database update that refuses past the cap (and past the site's own share, when one is set), so two
 * runs at once can't go over it together.
 */

export const dayOf = (now: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

type Native = {
  updateOne: (filter: object, update: object, options?: object) => Promise<{ matchedCount: number; modifiedCount: number; upsertedCount?: number }>
  findOne: (filter: object) => Promise<Record<string, unknown> | null>
}

export function nativeOf(payload: Payload, slug: string): Native {
  const c = (payload.db as unknown as { collections?: Record<string, { collection?: Partial<Native> }> }).collections?.[slug]?.collection
  if (!c?.updateOne || !c.findOne) throw new Error('Playlists: the unit ledger and review claims need MongoDB. Other database adapters aren’t supported yet.')
  return c as Native
}

export type DayUsage = { day: string; units: number; quotaStopped: boolean }

export function ledger(payload: Payload, o: ResolvedOptions, now: () => Date) {
  const native = () => nativeOf(payload, o.collections.usage)
  const today = () => dayOf(now(), o.quotaTimeZone)
  async function ensure(day: string) {
    const at = now()
    await native().updateOne({ day }, { $setOnInsert: { day, units: 0, quotaStopped: false, bySite: {}, digests: {}, createdAt: at, updatedAt: at } }, { upsert: true }).catch((error: { code?: number }) => {
      // Two runs creating the same day at once: the unique index keeps one; the other finds it.
      if (error?.code !== 11000) throw error
    })
  }
  return {
    today,
    /**
     * Reserve `units` for a call: `ok`, or why not. `quota` when the day is stopped (by this run or another), `cap` when
     * the cap would be passed. Nothing is counted unless it's `ok`.
     */
    async reserve(units: number, site: SiteId | null): Promise<'ok' | 'cap' | 'site-cap' | 'quota'> {
      if (!(Number.isInteger(units) && units > 0)) return 'cap'
      const day = today()
      await ensure(day)
      const mine = `bySite.${siteKey(site)}`
      // The site's own share, in the same atomic update: a site with nothing counted yet has no value there, and passes.
      const share = o.siteDailyUnitCap === null ? {} : { [mine]: { $not: { $gt: o.siteDailyUnitCap - units } } }
      const r = await native().updateOne({ day, quotaStopped: { $ne: true }, units: { $lte: o.dailyUnitCap - units }, ...share }, { $inc: { units, [mine]: units }, $set: { updatedAt: now() } })
      if (r.modifiedCount === 1) return 'ok'
      const doc = await native().findOne({ day })
      if (doc?.quotaStopped === true) return 'quota'
      if (Number(doc?.units ?? 0) > o.dailyUnitCap - units) return 'cap'
      return o.siteDailyUnitCap === null ? 'cap' : 'site-cap'
    },
    /** YouTube said the quota is used up: nothing more today, for any creator. */
    async stopForQuota(): Promise<void> {
      const day = today()
      await ensure(day)
      await native().updateOne({ day }, { $set: { quotaStopped: true, updatedAt: now() } })
    },
    async usage(): Promise<DayUsage> {
      const day = today()
      const doc = await native().findOne({ day })
      return { day, units: Number(doc?.units ?? 0), quotaStopped: doc?.quotaStopped === true }
    },
    /** Claim a site's digest for the ledger's day, once. True only for the first caller. */
    async claimDigest(site: SiteId | null, kind: 'daily' | 'urgent'): Promise<boolean> {
      const day = today()
      await ensure(day)
      const path = `digests.${siteKey(site)}.${kind}`
      // The daily digest also stands down when the urgent one already went today: one digest a day unless the queue jumps.
      const free = kind === 'daily' ? { [path]: { $exists: false }, [`digests.${siteKey(site)}.urgent`]: { $exists: false } } : { [path]: { $exists: false } }
      const r = await native().updateOne({ day, ...free }, { $set: { [path]: now(), updatedAt: now() } })
      return r.modifiedCount === 1
    },
    /** A send that failed gives its claim back, so the next run tries again. */
    async releaseDigest(site: SiteId | null, kind: 'daily' | 'urgent'): Promise<void> {
      await native().updateOne({ day: today() }, { $unset: { [`digests.${siteKey(site)}.${kind}`]: '' }, $set: { updatedAt: now() } })
    },
  }
}

/** A site id as a safe key: no dots or dollar signs reach a field path. */
export const siteKey = (site: SiteId | null) => (site === null ? '_all' : `s_${String(site).replace(/[^A-Za-z0-9_-]/g, '_')}`)

export type Ledger = ReturnType<typeof ledger>
