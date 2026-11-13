import type { PayloadRequest, Where } from 'payload'

import { idOf } from '../access.js'
import { queueSitesOf, waitingWhere } from '../curation.js'
import { youtubeImage } from '../ids.js'
import { PageError, serve, whole, type Result } from './result.js'

/** A video waiting for a curator's yes, as the review queue shows it. */
export type QueueRow = {
  id: string
  youtubeId: string
  title: string
  creator: string
  publishedAt: string | null
  duration: number | null
  thumbnail: string | null
  description: string
  kind: string | null
  /** Why it waits, in the sync's words. */
  reason: string | null
  embeddable: boolean | null
}
export type ReviewQueueData = { rows: QueueRow[]; total: number; page: number; pages: number }

export const QUEUE_PAGE_SIZE = 20

/**
 * The curator's review queue: the videos waiting for a yes on the sites this person curates (every site for an admin).
 * Signed out answers `signIn`; anyone without a curator's or editor's role answers `notStaff`. The read then uses the
 * person's own access (`overrideAccess: false`), so another site's videos can't come back even if the list of sites
 * were wrong.
 */
export function reviewQueue(req: PayloadRequest, input: { page?: unknown; site?: unknown } = {}): Promise<Result<ReviewQueueData>> {
  return serve(req, async (o) => {
    if (!req.user) throw new PageError('signIn')
    const site = typeof input.site === 'string' || typeof input.site === 'number' ? input.site : null
    const who = await queueSitesOf(o, req, site)
    if (!who) throw new PageError('notStaff')
    const page = whole(input.page, 1, 100_000)
    const r = await req.payload.find({
      collection: o.collections.videos,
      where: waitingWhere(who.sites, o) as Where,
      sort: '-publishedAt',
      page,
      limit: QUEUE_PAGE_SIZE,
      depth: 1,
      overrideAccess: false,
      user: req.user,
      req,
      // The site field is read too: the internal fields' read rule needs the record's site, and refuses without it.
      select: { title: true, youtubeId: true, creator: true, publishedAt: true, duration: true, thumbnail: true, description: true, kind: true, hiddenReason: true, embeddable: true, ...(o.scope.field ? { [o.scope.field]: true } : {}) } as never,
      populate: { [o.collections.creators]: { name: true } } as never,
    })
    const rows = (r.docs as unknown as Record<string, unknown>[]).map(
      (v): QueueRow => ({
        id: String(idOf(v.id)),
        youtubeId: String(v.youtubeId ?? ''),
        title: String(v.title ?? ''),
        creator: v.creator && typeof v.creator === 'object' ? String((v.creator as { name?: unknown }).name ?? '') : '',
        publishedAt: typeof v.publishedAt === 'string' ? v.publishedAt : null,
        duration: typeof v.duration === 'number' && v.duration > 0 ? v.duration : null,
        thumbnail: youtubeImage(typeof v.thumbnail === 'string' ? v.thumbnail : null),
        description: String(v.description ?? '').slice(0, 2000),
        kind: typeof v.kind === 'string' ? v.kind : null,
        reason: typeof v.hiddenReason === 'string' && v.hiddenReason ? v.hiddenReason : null,
        embeddable: typeof v.embeddable === 'boolean' ? v.embeddable : null,
      }),
    )
    return { rows, total: r.totalDocs, page: r.page ?? page, pages: r.totalPages }
  })
}
