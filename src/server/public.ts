import type { PayloadRequest, Where } from 'payload'

import { idOf } from '../access.js'
import { topicNames } from '../collections.js'
import { isVideoId, youtubeImage } from '../ids.js'
import type { Option, ResolvedOptions } from '../types.js'
import { PageError, serve, whole, type Result } from './result.js'

/**
 * Server functions for the public pages. Each is a plain async function `(req, input)` that answers plain JSON or
 * `{ error: { code, message } }`. Mount them in your own thin routes.
 *
 * Every read here is made as a signed-out visitor of the request's site, whoever is looking: the request's person is
 * left out, and the collections' own read access decides what comes back (shown videos of listed creators, public
 * fields only). So a public page shows a curator exactly what it shows everyone else, and nothing here can read around
 * the access rules. The only filters are the ones named in each input, checked before they're used.
 */

export type CreatorCard = {
  id: string
  name: string
  slug: string
  bio: string | null
  avatar: string | null
  website: string | null
  channels: { handle: string; title: string | null; channelId: string | null }[]
}
export type VideoCard = {
  id: string
  youtubeId: string
  title: string
  publishedAt: string | null
  /** Seconds. */
  duration: number | null
  thumbnail: string | null
  kind: string | null
  /** The kind in words, from the site's `kinds`. */
  kindLabel: string | null
  /** From YouTube; `false` means the page links out instead of embedding. */
  embeddable: boolean | null
  creator: { id: string; name: string; slug: string } | null
}
export type VideoList = { videos: VideoCard[]; page: number; pages: number; total: number }
export type CreatorListData = { creators: CreatorCard[] }
export type VideosData = VideoList & { kinds: Option[]; kind: string | null; topic: string | null }
export type CreatorPageData = VideoList & { creator: CreatorCard }
export type VideoPageData = { video: VideoCard & { description: string; topics: string[] } }

export const PAGE_SIZE = 24
const MAX_PAGE_SIZE = 48

/** The same request without its person: the visitor every public page is read as. */
export function visitorOf(req: PayloadRequest): PayloadRequest {
  return { ...req, headers: req.headers, url: req.url, user: null } as PayloadRequest
}

type Doc = Record<string, unknown>
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const httpLink = (v: unknown): string | null => {
  try {
    const u = new URL(String(v ?? ''))
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}

function creatorCard(c: Doc): CreatorCard {
  return {
    id: String(c.id),
    name: String(c.name ?? ''),
    slug: String(c.slug ?? ''),
    bio: str(c.bio),
    avatar: youtubeImage(str(c.avatar)),
    website: httpLink(c.website),
    channels: (Array.isArray(c.channels) ? (c.channels as Doc[]) : []).map((ch) => ({ handle: String(ch.handle ?? ''), title: str(ch.title), channelId: str(ch.channelId) })),
  }
}

function videoCard(o: ResolvedOptions, v: Doc): VideoCard {
  const c = v.creator && typeof v.creator === 'object' ? (v.creator as Doc) : null
  const kind = str(v.kind)
  return {
    id: String(v.id),
    youtubeId: String(v.youtubeId ?? ''),
    title: String(v.title ?? ''),
    publishedAt: str(v.publishedAt),
    duration: typeof v.duration === 'number' && v.duration > 0 ? v.duration : null,
    thumbnail: youtubeImage(str(v.thumbnail)),
    kind,
    kindLabel: kind ? (o.kinds.find((k) => k.value === kind)?.label ?? null) : null,
    embeddable: typeof v.embeddable === 'boolean' ? v.embeddable : null,
    creator: c && c.name ? { id: String(c.id), name: String(c.name), slug: String(c.slug ?? '') } : null,
  }
}

/**
 * A read the access rules refuse outright (no site for this request, so nothing is public) is an empty answer, not a
 * failure: the page shows its empty state or "not found".
 */
async function orNothing<T extends { docs: unknown[] }>(read: Promise<T>): Promise<T | { docs: never[]; page: 1; totalPages: 1; totalDocs: 0 }> {
  try {
    return await read
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status === 403) return { docs: [], page: 1, totalPages: 1, totalDocs: 0 }
    throw error
  }
}

const CREATOR_SELECT = { name: true, slug: true, bio: true, avatar: true, website: true, channels: true }
const videoSelect = (o: ResolvedOptions, full = false) => ({
  title: true,
  youtubeId: true,
  creator: true,
  publishedAt: true,
  duration: true,
  thumbnail: true,
  kind: true,
  embeddable: true,
  ...(full ? { description: true, ...(o.topics ? { [topicNames(o).field]: true } : {}) } : {}),
})

async function videosWhere(o: ResolvedOptions, visitor: PayloadRequest, where: Where[], input: { page?: unknown; perPage?: unknown }): Promise<VideoList> {
  const page = whole(input.page, 1, 100_000)
  const r = await orNothing(visitor.payload.find({
    collection: o.collections.videos,
    where: where.length ? { and: where } : {},
    sort: '-publishedAt',
    page,
    limit: whole(input.perPage, PAGE_SIZE, MAX_PAGE_SIZE),
    depth: 1,
    overrideAccess: false,
    req: visitor,
    select: videoSelect(o) as never,
    populate: { [o.collections.creators]: { name: true, slug: true } } as never,
  }))
  return { videos: (r.docs as unknown as Doc[]).map((v) => videoCard(o, v)), page: r.page ?? page, pages: r.totalPages, total: r.totalDocs }
}

/** The site's listed creators, in the curators' order. */
export function listCreators(req: PayloadRequest): Promise<Result<CreatorListData>> {
  return serve(req, async (o) => {
    const visitor = visitorOf(req)
    const { docs } = await orNothing(visitor.payload.find({ collection: o.collections.creators, sort: '_order', pagination: false, depth: 0, overrideAccess: false, req: visitor, select: CREATOR_SELECT as never }))
    return { creators: (docs as unknown as Doc[]).map(creatorCard) }
  })
}

/** The video grid: the site's shown videos, newest first, with the kind and topic filters when asked for. */
export function listVideos(req: PayloadRequest, input: { page?: unknown; perPage?: unknown; kind?: unknown; topic?: unknown } = {}): Promise<Result<VideosData>> {
  return serve(req, async (o) => {
    const where: Where[] = []
    const kind = typeof input.kind === 'string' && o.kinds.some((k) => k.value === input.kind) ? input.kind : null
    if (input.kind !== undefined && input.kind !== null && input.kind !== '' && !kind) throw new PageError('badInput')
    if (kind) where.push({ kind: { equals: kind } })
    let topic: string | null = null
    if (input.topic !== undefined && input.topic !== null && input.topic !== '') {
      if (!o.topics || !(typeof input.topic === 'string' || typeof input.topic === 'number') || !/^[\w-]{1,64}$/.test(String(input.topic))) throw new PageError('badInput')
      const t = topicNames(o)
      topic = String(input.topic)
      // Topic pages show only what's on them automatically or by a curator's yes.
      where.push({ [t.field]: { in: [topic] } }, { [t.state]: { in: ['auto', 'approved'] } })
    }
    const list = await videosWhere(o, visitorOf(req), where, input)
    return { ...list, kinds: o.kinds.filter((k) => o.shownKinds.includes(k.value)), kind, topic }
  })
}

/** One creator, by slug, with their videos. An unlisted creator and one that doesn't exist get the same answer. */
export function getCreator(req: PayloadRequest, input: { slug?: unknown; page?: unknown; perPage?: unknown }): Promise<Result<CreatorPageData>> {
  return serve(req, async (o) => {
    if (typeof input?.slug !== 'string' || !input.slug || input.slug.length > 120) throw new PageError('notFound')
    const visitor = visitorOf(req)
    const { docs } = await orNothing(visitor.payload.find({ collection: o.collections.creators, where: { slug: { equals: input.slug } }, limit: 1, depth: 0, overrideAccess: false, req: visitor, select: CREATOR_SELECT as never }))
    const creator = docs[0] as unknown as Doc | undefined
    if (!creator) throw new PageError('notFound')
    const list = await videosWhere(o, visitor, [{ creator: { equals: idOf(creator.id) } }], input)
    return { ...list, creator: creatorCard(creator) }
  })
}

/** One video, by its YouTube ID, for the page with the player. A hidden video and one that doesn't exist get the same answer. */
export function getVideo(req: PayloadRequest, input: { youtubeId?: unknown }): Promise<Result<VideoPageData>> {
  return serve(req, async (o) => {
    if (!isVideoId(input?.youtubeId)) throw new PageError('notFound')
    const visitor = visitorOf(req)
    const { docs } = await orNothing(visitor.payload.find({
      collection: o.collections.videos,
      where: { youtubeId: { equals: input.youtubeId } },
      limit: 1,
      depth: 1,
      overrideAccess: false,
      req: visitor,
      select: videoSelect(o, true) as never,
      populate: { [o.collections.creators]: { name: true, slug: true }, ...(o.topics ? { [o.topics.relationTo]: {} } : {}) } as never,
    }))
    const v = docs[0] as unknown as Doc | undefined
    if (!v) throw new PageError('notFound')
    const topics = o.topics && Array.isArray(v[topicNames(o).field]) ? (v[topicNames(o).field] as unknown[]).map((x) => idOf(x)).filter((x): x is string => x !== null) : []
    return { video: { ...videoCard(o, v), description: String(v.description ?? ''), topics } }
  })
}
