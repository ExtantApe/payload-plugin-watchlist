// Pure checks with no Node imports, so the client player can use them in the browser.

/** YouTube's own image hosts: thumbnails, logos and avatars come only from there, over https. */
export const YOUTUBE_IMAGE_HOSTS = ['i.ytimg.com', 'i9.ytimg.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com']
export function youtubeImage(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && YOUTUBE_IMAGE_HOSTS.includes(u.host) && !u.username && !u.password && !u.port ? u.toString() : null
  } catch {
    return null
  }
}

/** A YouTube video ID: 11 characters of letters, digits, `-` and `_`. */
export const isVideoId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{11}$/.test(v)
/** A YouTube channel ID: `UC` and 22 more. */
export const isChannelId = (v: unknown): v is string => typeof v === 'string' && /^UC[\w-]{22}$/.test(v)
