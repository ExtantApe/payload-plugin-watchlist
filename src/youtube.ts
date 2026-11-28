/**
 * A small YouTube Data API v3 client: read-only, an API key passed in by the site. List calls cost 1 unit per page
 * of 50 (from the site's notes; not checked against Google's current quota table). `search.list` (100 units) is never
 * used.
 *
 * The key goes in the query string, as the API requires, so this client never logs or returns a request URL. Its
 * errors carry YouTube's message with the key cut out, never the URL.
 */

export type YtChannel = { id: string; title: string; description: string; avatar: string | null; uploads: string }
export type YtVideo = {
  id: string
  title: string
  description: string
  publishedAt: string
  thumbnail: string | null
  /** Seconds. */
  duration: number
  /** Live, upcoming, or a past live stream. */
  live: boolean
  /** Taller than wide, from the embed player's shape. */
  vertical: boolean
  /** `status.embeddable`; false means link out. */
  embeddable: boolean
  /** `status.madeForKids`, stored for the site to decide on. */
  madeForKids: boolean | null
}

/** Why a call failed: the quota is used up, a rate limit or YouTube's own error (worth a retry), or anything else. */
export type YtFailure = 'quota' | 'retry' | 'other'

export class YouTubeError extends Error {
  constructor(
    message: string,
    readonly failure: YtFailure,
  ) {
    super(message)
    this.name = 'YouTubeError'
  }
}

const BASE = 'https://www.googleapis.com/youtube/v3'

/** ISO 8601 duration (PT1H2M3S) to seconds. */
export const seconds = (iso: string | undefined) => {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso ?? '')
  return m ? Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0) : 0
}

/** Cut the key, and anything URL-shaped, out of a message. */
export function scrub(message: string, key: string): string {
  let out = String(message)
  if (key) out = out.split(key).join('[key]')
  return out.replace(/https?:\/\/\S+/g, '[url]').slice(0, 300)
}

type Thumbs = Record<string, { url: string } | undefined>
const thumb = (t?: Thumbs) => t?.maxres?.url ?? t?.high?.url ?? t?.medium?.url ?? t?.default?.url ?? null

export type DataApi = ReturnType<typeof dataApi>

/** Each method's cost in units, before it's called, so the ledger can refuse first. */
export const COST = { channel: 1, playlistPage: 1, videos: 1, playlistTitle: 1 } as const

export function dataApi(key: string, fetcher: typeof fetch) {
  if (typeof key !== 'string' || !key) throw new Error('Playlists: the Data API needs a key.')
  async function get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
    const q = new URLSearchParams(Object.entries({ ...params, key }).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)] as [string, string]])))
    let res: Response
    try {
      res = await fetcher(`${BASE}/${path}?${q}`, { headers: { Accept: 'application/json' } })
    } catch (error) {
      throw new YouTubeError(`YouTube ${path}: ${scrub((error as Error | null)?.message ?? 'no answer', key)}`, 'retry')
    }
    const body = (await res.json().catch(() => null)) as (T & { error?: { message?: string; errors?: { reason?: string }[] } }) | null
    if (!res.ok || !body) {
      const reason = body?.error?.errors?.[0]?.reason ?? ''
      const failure: YtFailure = /quotaExceeded|dailyLimitExceeded/i.test(reason)
        ? 'quota'
        : res.status === 429 || res.status >= 500 || /rateLimit/i.test(reason)
          ? 'retry'
          : 'other'
      throw new YouTubeError(`YouTube ${path}: ${scrub(body?.error?.message ?? String(res.status), key)}`, failure)
    }
    return body
  }
  return {
    /** A channel by handle (`@name`) or by channel ID (from a pasted link). */
    async channel(handleOrId: string): Promise<YtChannel | null> {
      const v = handleOrId.trim()
      const by = /^UC[\w-]{22}$/.test(v) ? { id: v } : { forHandle: v.startsWith('@') ? v : `@${v}` }
      const body = await get<{ items?: { id: string; snippet: { title: string; description: string; thumbnails?: Thumbs }; contentDetails: { relatedPlaylists: { uploads: string } } }[] }>('channels', {
        part: 'snippet,contentDetails',
        ...by,
      })
      const c = body.items?.[0]
      return c ? { id: c.id, title: c.snippet.title, description: c.snippet.description ?? '', avatar: thumb(c.snippet.thumbnails), uploads: c.contentDetails.relatedPlaylists.uploads } : null
    },
    /** One page of a playlist's video IDs (newest first for uploads). */
    async playlistPage(playlistId: string, pageToken?: string) {
      const body = await get<{ items?: { contentDetails: { videoId: string } }[]; nextPageToken?: string }>('playlistItems', { part: 'contentDetails', playlistId, maxResults: 50, pageToken })
      return { ids: (body.items ?? []).map((i) => i.contentDetails.videoId), next: body.nextPageToken ?? null }
    },
    async playlistTitle(playlistId: string) {
      const body = await get<{ items?: { snippet: { title: string } }[] }>('playlists', { part: 'snippet', id: playlistId })
      return body.items?.[0]?.snippet.title ?? null
    },
    /** Details for up to 50 videos. Missing ones are gone (deleted or private). */
    async videos(ids: string[]): Promise<YtVideo[]> {
      if (!ids.length) return []
      if (ids.length > 50) throw new Error('Playlists: at most 50 videos a call.')
      const body = await get<{
        items?: {
          id: string
          snippet: { title: string; description?: string; publishedAt: string; thumbnails?: Thumbs; liveBroadcastContent?: string }
          contentDetails?: { duration?: string }
          liveStreamingDetails?: unknown
          player?: { embedWidth?: string | number; embedHeight?: string | number }
          status?: { embeddable?: boolean; madeForKids?: boolean }
        }[]
      }>('videos', { part: 'snippet,contentDetails,liveStreamingDetails,player,status', id: ids.join(','), maxResults: 50, maxWidth: 400 })
      return (body.items ?? []).map((v) => ({
        id: v.id,
        title: v.snippet.title,
        description: v.snippet.description ?? '',
        publishedAt: v.snippet.publishedAt,
        thumbnail: thumb(v.snippet.thumbnails),
        duration: seconds(v.contentDetails?.duration),
        live: Boolean(v.liveStreamingDetails) || (v.snippet.liveBroadcastContent ?? 'none') !== 'none',
        vertical: Number(v.player?.embedHeight) > Number(v.player?.embedWidth),
        // Only an explicit true embeds; anything else links out.
        embeddable: v.status?.embeddable === true,
        madeForKids: typeof v.status?.madeForKids === 'boolean' ? v.status.madeForKids : null,
      }))
    },
  }
}
