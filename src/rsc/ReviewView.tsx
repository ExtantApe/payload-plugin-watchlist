import { DefaultTemplate } from '@payloadcms/next/templates'
import type { AdminViewServerProps, Payload, PayloadRequest } from 'payload'

import { ReviewQueue } from '../client/ReviewQueue.js'
import { SyncNowButton } from '../client/SyncNowButton.js'
import { queueSitesOf, reviewQueueCount } from '../curation.js'
import { isError } from '../server/result.js'
import { reviewQueue } from '../server/staff.js'
import { optionsOf } from '../sync.js'
import { LINK_TARGET } from '../ui.js'

/**
 * The curator's review queue in the admin: the videos waiting for a yes, with approve and reject. The list comes from
 * `reviewQueue`, which refuses anyone who isn't a curator or editor; the buttons post to the plugin's review route.
 */
export async function ReviewView({ initPageResult, params, searchParams }: AdminViewServerProps) {
  const { req, permissions, visibleEntities, locale } = initPageResult
  const o = optionsOf(req.payload)
  const admin = req.payload.config.routes.admin
  const page = typeof searchParams?.page === 'string' ? searchParams.page : undefined
  const result = await reviewQueue(req, { page })
  const here = `${admin}${o.adminReviewPath}`
  return (
    <DefaultTemplate i18n={req.i18n} locale={locale} params={params} payload={req.payload} permissions={permissions} req={req} searchParams={searchParams} user={req.user ?? undefined} visibleEntities={visibleEntities}>
      <div className="gutter--left gutter--right" style={{ paddingBlock: 'calc(var(--base) * 2)', maxWidth: 900 }}>
        <h1>Video review</h1>
        {isError(result) ? (
          <p role="alert">{result.error.message}</p>
        ) : (
          <>
            <ReviewQueue key={result.page} rows={result.rows} total={result.total} api={req.payload.config.routes.api} collection={o.collections.videos} editBase={`${admin}/collections/${o.collections.videos}`} kinds={o.kinds.map((k) => ({ label: k.label, value: k.value }))} />
            {result.pages > 1 ? (
              <nav aria-label="Pages" style={{ display: 'flex', flexWrap: 'wrap', gap: '0 1rem', alignItems: 'center', marginTop: '1.5rem' }}>
                {result.page > 1 ? (
                  <a href={`${here}?page=${result.page - 1}`} rel="prev" style={LINK_TARGET}>
                    Newer videos
                  </a>
                ) : null}
                <span aria-current="page">
                  Page {result.page} of {result.pages}
                </span>
                {result.page < result.pages ? (
                  <a href={`${here}?page=${result.page + 1}`} rel="next" style={LINK_TARGET}>
                    Older videos
                  </a>
                ) : null}
              </nav>
            ) : null}
          </>
        )}
      </div>
    </DefaultTemplate>
  )
}

/** The admin nav's link to the review queue, with how many wait. Only curators, editors and admins see it. */
export async function ReviewNavLink({ payload, user }: { payload: Payload; user?: unknown }) {
  if (!user) return null
  const o = optionsOf(payload)
  const req = { user, payload, context: {} } as unknown as PayloadRequest
  if (!(await queueSitesOf(o, req))) return null
  const waiting = await reviewQueueCount(payload, { req })
  return (
    <a className="nav__link" href={`${payload.config.routes.admin}${o.adminReviewPath}`} style={{ display: 'flex', alignItems: 'center', minHeight: 44 }}>
      <span className="nav__link-label">Video review{waiting ? ` (${waiting} waiting)` : ''}</span>
    </a>
  )
}

/** The creator's Sync now field: a UI field, so it stores nothing. */
export function SyncNowField({ id, payload, collectionSlug }: { id?: number | string; payload: Payload; collectionSlug?: string }) {
  return <SyncNowButton id={id ?? null} api={payload.config.routes.api} collection={collectionSlug ?? optionsOf(payload).collections.creators} />
}
