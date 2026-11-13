/**
 * A channel's public feed, `https://www.youtube.com/feeds/videos.xml?channel_id=<id>`. Not verified (no call to YouTube
 * was made while building this): that it needs no key, lists about the 15 newest uploads, includes Shorts and
 * livestreams, or answers conditional requests. The feed has no duration, live flag or shape, so the rules can't be
 * checked from it: it only says "something new".
 */

import { isChannelId, isVideoId, youtubeImage } from './rules.js'

export type FeedEntry = { id: string; title: string; published: string | null; description: string; thumbnail: string | null }

export class FeedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeedError'
  }
}

export const feedUrl = (channelId: string) => `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
export function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
      }
      return ENTITIES[e.toLowerCase()] ?? all
    })
    .trim()
}

const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml)
  return m ? decode(m[1]!) : null
}

/** The entries of a feed, newest first as YouTube lists them. Throws `FeedError` on anything that isn't a feed. */
export function parseFeed(xml: string): FeedEntry[] {
  if (typeof xml !== 'string' || !/<feed[\s>]/.test(xml)) throw new FeedError('Not a feed.')
  const out: FeedEntry[] = []
  const entries = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g
  for (let m = entries.exec(xml); m; m = entries.exec(xml)) {
    const body = m[1]!
    const id = tag(body, 'yt:videoId')
    if (!isVideoId(id)) continue
    const thumbUrl = /<media:thumbnail\s[^>]*url="([^"]+)"/.exec(body)?.[1]
    out.push({
      id,
      title: (tag(body, 'title') ?? '').slice(0, 300),
      published: tag(body, 'published'),
      description: (tag(body, 'media:description') ?? '').slice(0, 2000),
      thumbnail: youtubeImage(thumbUrl ? decode(thumbUrl) : null),
    })
  }
  return out
}

/** Read one channel's feed. Errors never carry the URL. */
export async function readFeed(channelId: string, fetcher: typeof fetch): Promise<FeedEntry[]> {
  if (!isChannelId(channelId)) throw new FeedError('Not a channel ID.')
  let res: Response
  try {
    res = await fetcher(feedUrl(channelId), { headers: { Accept: 'application/atom+xml, application/xml' } })
  } catch {
    throw new FeedError('The feed did not answer.')
  }
  if (!res.ok) throw new FeedError(`The feed answered ${res.status}.`)
  return parseFeed(await res.text())
}
