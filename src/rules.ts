import { createHash } from 'node:crypto'

/** Bump when the judging changes, so stored videos are judged again. */
export const RULES_VERSION = 1

export { YOUTUBE_IMAGE_HOSTS, youtubeImage, isVideoId, isChannelId } from './ids.js'
import { isChannelId } from './ids.js'

/** A channel ID from a pasted channel link or an ID, or null (handles need one API call). */
export function channelIdOf(value: string | null | undefined): string | null {
  const v = (value ?? '').trim()
  if (isChannelId(v)) return v
  const m = /youtube\.com\/channel\/(UC[\w-]{22})(?:[/?#]|$)/.exec(v)
  return m ? m[1]! : null
}

/** A playlist ID from a link or an ID. */
export const playlistIdOf = (value: string) => /[?&]list=([\w-]+)/.exec(value)?.[1] ?? value.trim()

/** What the rules need to know about a video. */
export type RuleVideo = { id: string; title: string; description: string; duration: number; live: boolean; vertical?: boolean }

/** Shorts: up to 61 seconds, or up to 3 minutes with #shorts (the API has no Shorts flag). */
export const isShort = (v: Pick<RuleVideo, 'duration' | 'title' | 'description'>) =>
  (v.duration > 0 && v.duration <= 61) || (v.duration <= 180 && /#shorts?\b/i.test(`${v.title} ${v.description}`))

/** A reply to a viewer's comment ("Replying to @name"), usually a quick vertical clip. */
export const isCommentReply = (v: Pick<RuleVideo, 'title' | 'description'>) =>
  /\brepl(y|ying)\s+to\s+@/i.test(`${v.title}\n${v.description.slice(0, 200)}`) || /^@\w/.test(v.title.trim())

/** One phrase per line, trimmed and lowercased; blank lines dropped. */
export const lines = (text?: string | null) =>
  (text ?? '')
    .split('\n')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)

export type ChannelRules = {
  minMinutes?: number | null
  /** Video IDs in the channel's playlists, by rule. */
  include: Set<string>
  exclude: Set<string>
  /** Topic playlists count as included. */
  topic: Set<string>
  keywords: string[]
}

/**
 * The per-channel rules, in order. Returns why a video is hidden, or null when the rules let it through to the
 * classifier.
 */
export function ruleHide(v: RuleVideo, r: ChannelRules): string | null {
  if (v.live) return 'Rule: live stream'
  if (isShort(v)) return 'Rule: Short'
  if (v.vertical) return 'Rule: vertical video'
  if (isCommentReply(v)) return 'Rule: comment reply'
  if (r.minMinutes && v.duration > 0 && v.duration < r.minMinutes * 60) return `Rule: under ${r.minMinutes} min`
  if (r.exclude.has(v.id)) return 'Rule: excluded playlist'
  if (r.include.size && !r.include.has(v.id) && !r.topic.has(v.id)) return 'Rule: not in an included playlist'
  const text = `${v.title}\n${v.description}`.toLowerCase()
  const kw = r.keywords.find((k) => text.includes(k))
  return kw ? `Rule: mentions “${kw}”` : null
}

/** A short hash of a channel's rules and the rules version: a change re-judges stored videos. */
export function ruleKeyOf(parts: unknown[]): string {
  return createHash('sha1')
    .update(JSON.stringify([RULES_VERSION, ...parts]))
    .digest('hex')
    .slice(0, 16)
}

export type ShownInput = { choice?: string | null; passedRules?: boolean | null; curation?: string | null; source?: string | null; unavailable?: boolean | null }

/**
 * Whether a video is shown. A curator's choice wins over everything. Otherwise it shows only when its curation is
 * exactly `rules`, it passed the rules and the classifier, and its details came from the API (an RSS-only video can't
 * be checked against the rules). Anything missing or unknown is a no. Gone videos never show.
 */
export function computeShown(v: ShownInput): boolean {
  if (v.unavailable === true) return false
  if (v.choice === 'show') return true
  if (v.choice === 'hide') return false
  return v.curation === 'rules' && v.passedRules === true && v.source === 'api'
}
