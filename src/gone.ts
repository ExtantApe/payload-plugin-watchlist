import { createLocalReq, type Payload, type PayloadRequest } from 'payload'

import { idOf } from './access.js'
import { ownContext, syncContext } from './collections.js'
import { contextFor, GONE_TITLE, optionsOf } from './sync.js'
import type { SiteId } from './types.js'
import { COST, dataApi, YouTubeError } from './youtube.js'

export type GoneSweepReport = {
  mode: 'keep' | 'clear'
  /** Why nothing ran: the mode is `keep`, outside calls are off, or there's no API key to ask YouTube with. */
  skipped?: 'keep' | 'disabled' | 'no-key'
  /** Videos asked about. */
  checked: number
  /** Still gone: YouTube's details cleared, our own notes kept. */
  cleared: number
  /** Back on YouTube: marked back, and judged again at the next sync. */
  returned: number
  units: number
  /** The day's cap, YouTube's quota or an error stopped it; `site-cap` means one or more sites had used their share and were left for the next run. */
  stopped?: 'cap' | 'site-cap' | 'quota' | 'error'
}

/**
 * The gone-videos sweep (the owner, 2026-11-11), for the site's cron. With `goneVideos.mode: 'keep'` (the default) it
 * does nothing at all. With `clear`, it takes the videos marked gone for longer than `clearAfterDays`, asks YouTube once
 * more about each (50 an API unit, reserved in the ledger first, so the daily cap holds), and then:
 * - still gone: YouTube's title, description, thumbnail, duration and playlists are cleared; the YouTube ID, the
 *   curator's choice, the kind and the topic links stay;
 * - back: marked back, to be judged again at the next sync.
 * Nothing is cleared without YouTube's answer: no key, outside calls off, the cap, a quota stop or an error all leave
 * the stored details as they are for the next run.
 */
export async function sweepGoneVideos(payload: Payload, opts: { now?: Date; limit?: number; req?: PayloadRequest } = {}): Promise<GoneSweepReport> {
  const o = optionsOf(payload)
  const report: GoneSweepReport = { mode: o.goneMode, checked: 0, cleared: 0, returned: 0, units: 0 }
  if (o.goneMode !== 'clear') return { ...report, skipped: 'keep' }
  const now = opts.now ?? new Date()
  const req = opts.req ?? (await createLocalReq({}, payload))
  const env = await contextFor(payload, o, req, () => now)
  if (!env.enabled) return { ...report, skipped: 'disabled' }
  if (!env.key) return { ...report, skipped: 'no-key' }
  const api = dataApi(env.key, env.fetcher)
  const before = new Date(now.getTime() - o.clearAfterDays * 86_400_000).toISOString()
  const limit = Math.max(1, Math.min(Number.isInteger(opts.limit) ? (opts.limit as number) : 500, 5000))
  const { docs } = await payload.find({
    collection: o.collections.videos,
    where: { and: [{ unavailable: { equals: true } }, { unavailableSince: { less_than_equal: before } }, { title: { not_equals: GONE_TITLE } }] },
    sort: 'unavailableSince',
    limit,
    depth: 0,
    overrideAccess: true,
    select: { youtubeId: true, locked: true, ...(o.scope.field ? { [o.scope.field]: true } : {}) } as never,
  })
  const all = docs as unknown as ({ id: string; youtubeId: string; locked?: boolean | null } & Record<string, unknown>)[]
  const update = (id: string, data: Record<string, unknown>) => payload.update({ collection: o.collections.videos, id, data: data as never, overrideAccess: true, depth: 0, context: syncContext, req: ownContext(req) })
  // One site's videos per call, so each site's units are counted to it.
  const siteOfDoc = (v: Record<string, unknown>): SiteId | null => (o.scope.field ? (idOf(v[o.scope.field]) as SiteId | null) : null)
  const bySite = new Map<SiteId | null, typeof all>()
  for (const v of all) bySite.set(siteOfDoc(v), [...(bySite.get(siteOfDoc(v)) ?? []), v])
  const batches = [...bySite].flatMap(([site, list]) => Array.from({ length: Math.ceil(list.length / 50) }, (_, i) => ({ site, batch: list.slice(i * 50, i * 50 + 50) })))
  for (const { site, batch } of batches) {
    const reserved = await env.ledger.reserve(COST.videos, site)
    if (reserved === 'site-cap') {
      // This site's share is used: leave its videos for tomorrow, and go on with the other sites.
      report.stopped = 'site-cap'
      continue
    }
    if (reserved !== 'ok') return { ...report, stopped: reserved }
    report.units += COST.videos
    let live: Set<string>
    try {
      live = new Set((await api.videos(batch.map((v) => v.youtubeId))).map((v) => v.id))
    } catch (error) {
      if (error instanceof YouTubeError && error.failure === 'quota') {
        await env.ledger.stopForQuota()
        return { ...report, stopped: 'quota' }
      }
      return { ...report, stopped: 'error' }
    }
    for (const v of batch) {
      report.checked++
      if (live.has(v.youtubeId)) {
        await update(v.id, { unavailable: false, ...(v.locked ? {} : { ruleKey: null }) })
        report.returned++
      } else {
        await update(v.id, { title: GONE_TITLE, description: null, thumbnail: null, duration: null, playlists: [] })
        report.cleared++
      }
    }
  }
  return report
}
