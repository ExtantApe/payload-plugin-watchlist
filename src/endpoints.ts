import { APIError, type Endpoint, type PayloadHandler } from 'payload'

/**
 * The admin's two routes. Each only hands the request to the function that checks the person itself (`syncNow`,
 * `reviewVideo`); a refusal is answered as `{ errors: [{ message }] }` with its status, in plain words, and isn't
 * logged as a failure. Anything unexpected is left to Payload, which answers without details.
 * The functions are imported when called, so the collections don't pull the sync in at config time.
 */

const refusals =
  (handler: PayloadHandler): PayloadHandler =>
  async (req) => {
    try {
      return await handler(req)
    } catch (error) {
      const e = error as { status?: unknown; isPublic?: unknown; message?: unknown } | null
      if (error instanceof APIError && typeof e?.status === 'number' && e.status >= 400 && e.status < 500) {
        const retryAfter = (error.data as { retryAfter?: unknown } | null)?.retryAfter
        const wait = typeof retryAfter === 'number' && retryAfter > 0 ? Math.ceil(retryAfter) : null
        return Response.json({ errors: [{ message: e.isPublic === true ? String(e.message) : 'Not allowed.' }], ...(wait ? { retryAfter: wait } : {}) }, { status: e.status, headers: wait ? { 'Retry-After': String(wait) } : {} })
      }
      throw error
    }
  }

/** POST /api/<creators>/:id/sync: Sync now, for editors of the creator's site. */
export const syncNowEndpoint: Endpoint = {
  path: '/:id/sync',
  method: 'post',
  handler: refusals(async (req) => {
    const { syncNow } = await import('./syncNow.js')
    const r = await syncNow(req.payload, { req, id: String(req.routeParams?.id ?? '') })
    return Response.json({ added: r.added, updated: r.updated, passed: r.passed, review: r.review, unavailable: r.unavailable, returned: r.returned, units: r.units, stopped: r.stopped ?? null, note: r.note })
  }),
}

/** POST /api/<videos>/:id/review with `{ "choice": "show" | "hide" }`: a curator's yes or no, from the review queue. */
export const reviewEndpoint: Endpoint = {
  path: '/:id/review',
  method: 'post',
  handler: refusals(async (req) => {
    let body: unknown = null
    try {
      body = await req.json?.()
    } catch {
      body = null
    }
    const choice = (body as { choice?: unknown } | null)?.choice
    if (choice !== 'show' && choice !== 'hide') throw new APIError('A choice is "show" or "hide".', 400, undefined, true)
    const { reviewVideo } = await import('./curation.js')
    return Response.json(await reviewVideo(req.payload, { req, id: String(req.routeParams?.id ?? ''), choice }))
  }),
}
