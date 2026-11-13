/**
 * A made-up YouTube: channels, videos, playlists and feeds in memory, answering the URLs the plugin builds. It records
 * every call (with the key cut out) so tests can count them. Nothing here touches the network.
 */
export type FakeVideo = {
  id: string
  title: string
  description?: string
  publishedAt?: string
  seconds?: number
  live?: boolean
  vertical?: boolean
  embeddable?: boolean
  madeForKids?: boolean
  gone?: boolean
}
export type FakeChannel = { id: string; handle: string; title: string; uploads: string; videos: string[] }

export function fakeYoutube() {
  const channels = new Map<string, FakeChannel>()
  const videos = new Map<string, FakeVideo>()
  const playlists = new Map<string, { title: string; ids: string[] }>()
  const calls: { kind: string; url: string }[] = []
  const feedState = { broken: false, status: 200 }
  /** Errors to answer the next API calls with, in order. */
  const failNext: { status: number; reason: string }[] = []
  const keysSeen: string[] = []

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const iso = (s: number) => `PT${Math.floor(s / 60)}M${s % 60}S`

  const fetcher = (async (input: unknown) => {
    const url = new URL(String(input))
    const key = url.searchParams.get('key')
    if (key) keysSeen.push(key)
    const safe = String(input).replace(/key=[^&]+/, 'key=…')
    if (url.host === 'www.youtube.com' && url.pathname === '/feeds/videos.xml') {
      calls.push({ kind: 'feed', url: safe })
      if (feedState.broken) return new Response('<html>nope</html>', { status: feedState.status })
      const ch = [...channels.values()].find((c) => c.id === url.searchParams.get('channel_id'))
      if (!ch) return new Response('', { status: 404 })
      const entries = ch.videos
        .map((id) => videos.get(id)!)
        .filter((v) => !v.gone)
        .slice(0, 15)
        .map(
          (v) =>
            `<entry><id>yt:video:${v.id}</id><yt:videoId>${v.id}</yt:videoId><title>${v.title.replace(/&/g, '&amp;')}</title><published>${v.publishedAt ?? '2026-11-01T00:00:00+00:00'}</published><media:group><media:thumbnail url="https://i.ytimg.com/vi/${v.id}/hqdefault.jpg" width="480" height="360"/><media:description>${(v.description ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</media:description></media:group></entry>`,
        )
        .join('')
      return new Response(`<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`, { status: 200 })
    }
    if (url.host !== 'www.googleapis.com') throw new Error(`unexpected host ${url.host}`)
    const kind = url.pathname.replace('/youtube/v3/', '')
    calls.push({ kind, url: safe })
    const fail = failNext.shift()
    if (fail) return json(fail.status, { error: { message: `Made-up failure (${fail.reason}) for key ${key}`, errors: [{ reason: fail.reason }] } })
    if (kind === 'channels') {
      const id = url.searchParams.get('id')
      const handle = url.searchParams.get('forHandle')
      const ch = [...channels.values()].find((c) => (id && c.id === id) || (handle && c.handle === handle))
      return json(200, { items: ch ? [{ id: ch.id, snippet: { title: ch.title, description: `About ${ch.title}`, thumbnails: { high: { url: `https://yt3.ggpht.com/${ch.id}` } } }, contentDetails: { relatedPlaylists: { uploads: ch.uploads } } }] : [] })
    }
    if (kind === 'playlistItems') {
      const pid = url.searchParams.get('playlistId')!
      const up = [...channels.values()].find((c) => c.uploads === pid)
      const ids = up ? up.videos.filter((v) => !videos.get(v)?.gone) : (playlists.get(pid)?.ids ?? [])
      const start = Number(url.searchParams.get('pageToken') ?? 0)
      const page = ids.slice(start, start + 50)
      return json(200, { items: page.map((videoId) => ({ contentDetails: { videoId } })), ...(start + 50 < ids.length ? { nextPageToken: String(start + 50) } : {}) })
    }
    if (kind === 'playlists') {
      const p = playlists.get(url.searchParams.get('id')!)
      return json(200, { items: p ? [{ snippet: { title: p.title } }] : [] })
    }
    if (kind === 'videos') {
      const ids = (url.searchParams.get('id') ?? '').split(',')
      const items = ids
        .map((id) => videos.get(id))
        .filter((v): v is FakeVideo => Boolean(v && !v.gone))
        .map((v) => ({
          id: v.id,
          snippet: { title: v.title, description: v.description ?? '', publishedAt: v.publishedAt ?? '2026-11-01T00:00:00Z', thumbnails: { high: { url: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` } }, liveBroadcastContent: v.live ? 'live' : 'none' },
          contentDetails: { duration: iso(v.seconds ?? 600) },
          player: v.vertical ? { embedWidth: 225, embedHeight: 400 } : { embedWidth: 400, embedHeight: 225 },
          status: { embeddable: v.embeddable ?? true, madeForKids: v.madeForKids ?? false },
        }))
      return json(200, { items })
    }
    return json(404, { error: { message: 'Not found' } })
  }) as typeof fetch

  return {
    fetch: fetcher,
    calls,
    keysSeen,
    feedState,
    failNext,
    api: () => calls.filter((c) => c.kind !== 'feed'),
    feeds: () => calls.filter((c) => c.kind === 'feed'),
    reset: () => (calls.length = 0),
    addChannel(id: string, handle: string, title = handle.slice(1)) {
      const ch = { id, handle, title, uploads: `UU${id.slice(2)}`, videos: [] }
      channels.set(id, ch)
      return ch
    },
    /** A new upload, newest first. */
    upload(channel: string, v: FakeVideo) {
      videos.set(v.id, v)
      channels.get(channel)!.videos.unshift(v.id)
      return v
    },
    video: (id: string) => videos.get(id),
    playlist(id: string, title: string, ids: string[]) {
      playlists.set(id, { title, ids })
    },
  }
}
export type FakeYoutube = ReturnType<typeof fakeYoutube>
