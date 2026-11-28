import type { PayloadRequest } from 'payload'

import { optionsOf } from '../sync.js'
import type { ResolvedOptions } from '../types.js'

/** A refusal or failure a page can show: `code` for the site's own handling, `message` in plain words. */
export type WatchError = { error: { code: string; message: string } }
/** What every server function answers: the plain result, or `{ error: { code, message } }`. Always plain JSON. */
export type Result<T> = T | WatchError

export const isError = (r: unknown): r is WatchError => {
  const e = (r as { error?: unknown } | null)?.error as { code?: unknown; message?: unknown } | undefined
  return Boolean(r && typeof r === 'object' && e && typeof e === 'object' && typeof e.code === 'string' && typeof e.message === 'string')
}

export const MESSAGES = {
  generic: 'Something went wrong on our side. Please try again in a minute.',
  notFound: 'We couldn’t find that. It may have been removed, or the link may be wrong.',
  badInput: 'That link doesn’t look right. Go back and try again.',
  signIn: 'Sign in to continue. If you’re signed in already, your session may have ended: sign in again.',
  notStaff: 'Video review is for the site’s curators and editors. If you should have access, ask a site admin.',
} as const

export class PageError extends Error {
  constructor(
    readonly code: keyof typeof MESSAGES,
    message?: string,
  ) {
    super(message ?? MESSAGES[code])
    this.name = 'PageError'
  }
}

/** Plain JSON at the boundary, so nothing a page can't serialize (a Date, an ObjectId) slips through. */
export const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * Runs a page's work. A `PageError` becomes its code and plain message; anything else is logged by name only and
 * answered with the general message, so no stack, query or record reaches the page.
 */
export async function serve<T>(req: PayloadRequest, fn: (o: ResolvedOptions) => Promise<T>): Promise<Result<T>> {
  let o: ResolvedOptions
  try {
    o = optionsOf(req.payload)
  } catch {
    return { error: { code: 'notInstalled', message: MESSAGES.generic } }
  }
  try {
    return plain(await fn(o))
  } catch (error) {
    if (error instanceof PageError) return { error: { code: error.code, message: error.message } }
    try {
      req.payload.logger.error({ name: (error as { name?: unknown } | null)?.name ?? typeof error }, 'Playlists: a page’s server function failed')
    } catch {
      // no logger: nothing more to do
    }
    return { error: { code: 'generic', message: MESSAGES.generic } }
  }
}

/** A whole number from 1 to `max`, else `fallback`. */
export const whole = (v: unknown, fallback: number, max: number): number => {
  const n = typeof v === 'string' && /^\d{1,6}$/.test(v) ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback
}
