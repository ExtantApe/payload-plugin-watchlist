import type { ReactNode } from 'react'

import { Player } from '../client/Player.js'
import type { CreatorCard, CreatorListData, CreatorPageData, VideoCard, VideoPageData, VideosData } from '../server/public.js'
import { isError, type Result } from '../server/result.js'
import { clock, clockWords, day, LINK_TARGET } from '../ui.js'
import { DefaultEmpty, DefaultShell, PageProblem, type EmptySlot, type ShellSlot, type TopicFilterSlot } from './slots.js'

/**
 * The public pages, as server components (no hooks, nothing kept in the browser): each takes its server function's
 * answer and draws the page. Mobile first: one column that widens into a grid, links and buttons at least 44 pixels,
 * real headings, lists and `<time>`, and nothing said by color alone. Mount them from thin routes in your site.
 */

export const TEXT = {
  watch: 'Watch',
  creators: 'Creators',
  noCreators: 'No creators yet',
  noCreatorsBody: 'When the curators add creators, they’ll be listed here.',
  noVideos: 'No videos yet',
  noVideosBody: 'Nothing matches here right now. Try another filter, or look again later.',
  allVideos: 'All videos',
  videos: 'Videos',
  website: 'Website',
  onYouTube: 'on YouTube',
  pages: 'Pages',
  previous: 'Newer videos',
  next: 'Older videos',
  pageOf: 'Page {page} of {pages}',
  type: 'Type',
  allTypes: 'All types',
  by: 'By',
  published: 'Published',
  length: 'Length',
} as const
export type PageText = { [K in keyof typeof TEXT]: string }

/** Where things live on the site. The plugin builds no URLs of its own. */
export type WatchPaths = {
  /** The video grid, e.g. `/watch`. */
  videos: string
  /** A creator's page, e.g. `/watch/c/<slug>`. */
  creator: (slug: string) => string
  /** A video's page, e.g. `/watch/v/<youtubeId>`. */
  video: (youtubeId: string) => string
}

/** What every page takes besides its data. All optional but `paths`. */
export type PageSlots = {
  paths: WatchPaths
  /** The page shell. */
  Shell?: ShellSlot
  /** The empty state. */
  Empty?: EmptySlot
  /** The site's topic filter, shown above the video grid. */
  TopicFilter?: TopicFilterSlot
  /** The site's wording; English when missing. */
  text?: Partial<PageText>
  /** For dates. Default `en-US`. */
  locale?: string
  /** A link to page `n` of the list being shown. Without it, there are no page links. */
  pageHref?: (page: number) => string
  /** A link to the grid filtered to a kind (`null`: every kind). Without it, there's no kind filter. */
  kindHref?: (kind: string | null) => string
}

const words = (slots: PageSlots): PageText => ({ ...TEXT, ...(slots.text ?? {}) })

function Frame<T>({ slots, title, intro, result, children }: { slots: PageSlots; title: string | ((data: T) => string); intro?: (data: T) => string | undefined; result: Result<T>; children: (data: T) => ReactNode }) {
  const Shell = slots.Shell ?? DefaultShell
  if (isError(result))
    return (
      <Shell title={typeof title === 'string' ? title : words(slots).watch}>
        <PageProblem message={result.error.message} />
      </Shell>
    )
  return (
    <Shell title={typeof title === 'string' ? title : title(result)} intro={intro?.(result)}>
      {children(result)}
    </Shell>
  )
}

/** A kind in words, with a border so it reads as a label without relying on color. */
export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="wl-badge" style={{ border: '1px solid currentColor', borderRadius: 4, padding: '0 0.35rem', fontSize: '0.875rem' }}>
      {children}
    </span>
  )
}

const GRID = { listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '1.5rem 1rem', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 17rem), 1fr))' } as const

/** The video grid: a list of cards, each a link to the video's page. `headingLevel` is the cards' heading level. */
export function VideoGrid({ videos, slots, headingLevel = 2, showCreator = true }: { videos: VideoCard[]; slots: PageSlots; headingLevel?: 2 | 3; showCreator?: boolean }) {
  const t = words(slots)
  const H = `h${headingLevel}` as 'h2' | 'h3'
  return (
    <ul className="wl-grid" style={GRID}>
      {videos.map((v) => (
        <li key={v.id}>
          <article>
            <a href={slots.paths.video(v.youtubeId)} style={{ display: 'block', minHeight: 44, color: 'inherit', textDecoration: 'none' }}>
              {v.thumbnail ? (
                <img src={v.thumbnail} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" width={480} height={270} style={{ display: 'block', width: '100%', height: 'auto', aspectRatio: '16 / 9', objectFit: 'cover' }} />
              ) : null}
              <H style={{ fontSize: '1rem', margin: '0.5rem 0 0.25rem', textDecoration: 'underline' }}>{v.title}</H>
            </a>
            <p style={{ margin: 0, display: 'flex', flexWrap: 'wrap', gap: '0 0.75rem', alignItems: 'center' }}>
              {showCreator && v.creator ? (
                <a href={slots.paths.creator(v.creator.slug)} style={LINK_TARGET}>
                  <span className="wl-sr" style={SR}>
                    {t.by}{' '}
                  </span>
                  {v.creator.name}
                </a>
              ) : null}
              {v.publishedAt ? (
                <time dateTime={v.publishedAt}>
                  <span style={SR}>{t.published} </span>
                  {day(v.publishedAt, slots.locale)}
                </time>
              ) : null}
              {v.duration ? (
                <span>
                  <span style={SR}>
                    {t.length} {clockWords(v.duration)}
                  </span>
                  <span aria-hidden="true">{clock(v.duration)}</span>
                </span>
              ) : null}
              {v.kindLabel ? <Badge>{v.kindLabel}</Badge> : null}
            </p>
          </article>
        </li>
      ))}
    </ul>
  )
}

/** Text for screen readers only. */
const SR = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 } as const

/** Newer and older links, with the page said in words. */
export function Pages({ page, pages, slots }: { page: number; pages: number; slots: PageSlots }) {
  const t = words(slots)
  if (!slots.pageHref || pages <= 1) return null
  return (
    <nav aria-label={t.pages} className="wl-pages" style={{ display: 'flex', flexWrap: 'wrap', gap: '0 1rem', alignItems: 'center', marginTop: '1.5rem' }}>
      {page > 1 ? (
        <a href={slots.pageHref(page - 1)} rel="prev" style={LINK_TARGET}>
          {t.previous}
        </a>
      ) : null}
      <span aria-current="page">{t.pageOf.replace('{page}', String(page)).replace('{pages}', String(pages))}</span>
      {page < pages ? (
        <a href={slots.pageHref(page + 1)} rel="next" style={LINK_TARGET}>
          {t.next}
        </a>
      ) : null}
    </nav>
  )
}

function CreatorSummary({ creator, slots, link }: { creator: CreatorCard; slots: PageSlots; link: boolean }) {
  const t = words(slots)
  return (
    <>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        {creator.avatar ? <img src={creator.avatar} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" width={56} height={56} style={{ borderRadius: '50%', flex: 'none' }} /> : null}
        {link ? (
          <h2 style={{ fontSize: '1.125rem', margin: 0 }}>
            <a href={slots.paths.creator(creator.slug)} style={LINK_TARGET}>
              {creator.name}
            </a>
          </h2>
        ) : null}
      </div>
      {creator.bio ? <p>{creator.bio}</p> : null}
      {creator.website || creator.channels.some((c) => c.channelId) ? (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexWrap: 'wrap', gap: '0 1rem' }}>
          {creator.website ? (
            <li>
              <a href={creator.website} rel="noopener noreferrer" style={LINK_TARGET}>
                {t.website}
                <span style={SR}>: {creator.name}</span>
              </a>
            </li>
          ) : null}
          {creator.channels
            .filter((c) => c.channelId)
            .map((c) => (
              <li key={c.channelId}>
                <a href={`https://www.youtube.com/channel/${encodeURIComponent(c.channelId!)}`} rel="noopener noreferrer" style={LINK_TARGET}>
                  {c.title || c.handle} {t.onYouTube}
                </a>
              </li>
            ))}
        </ul>
      ) : null}
    </>
  )
}

/** The creator list. */
export function CreatorListPage({ result, slots }: { result: Result<CreatorListData>; slots: PageSlots }) {
  const t = words(slots)
  const Empty = slots.Empty ?? DefaultEmpty
  return (
    <Frame slots={slots} title={t.creators} result={result}>
      {(data) =>
        data.creators.length ? (
          <ul className="wl-creators" style={GRID}>
            {data.creators.map((c) => (
              <li key={c.id}>
                <article>
                  <CreatorSummary creator={c} slots={slots} link />
                </article>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={t.noCreators} body={t.noCreatorsBody} />
        )
      }
    </Frame>
  )
}

/** One creator and their videos. */
export function CreatorPage({ result, slots }: { result: Result<CreatorPageData>; slots: PageSlots }) {
  const t = words(slots)
  const Empty = slots.Empty ?? DefaultEmpty
  return (
    <Frame slots={slots} title={(d: CreatorPageData) => d.creator.name} result={result}>
      {(data) => (
        <>
          <CreatorSummary creator={data.creator} slots={slots} link={false} />
          <h2>{t.videos}</h2>
          {data.videos.length ? <VideoGrid videos={data.videos} slots={slots} headingLevel={3} showCreator={false} /> : <Empty title={t.noVideos} body={t.noVideosBody} action={{ href: slots.paths.videos, label: t.allVideos }} />}
          <Pages page={data.page} pages={data.pages} slots={slots} />
        </>
      )}
    </Frame>
  )
}

/** The video grid page, with the site's topic filter above it and a kind filter as plain links. */
export function VideosPage({ result, slots }: { result: Result<VideosData>; slots: PageSlots }) {
  const t = words(slots)
  const Empty = slots.Empty ?? DefaultEmpty
  const TopicFilter = slots.TopicFilter
  return (
    <Frame slots={slots} title={t.watch} result={result}>
      {(data) => (
        <>
          {TopicFilter ? <TopicFilter topic={data.topic} kind={data.kind} /> : null}
          {slots.kindHref && data.kinds.length > 1 ? (
            <nav aria-label={t.type} className="wl-kinds">
              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1rem', display: 'flex', flexWrap: 'wrap', gap: '0 1rem' }}>
                {[{ label: t.allTypes, value: null as string | null }, ...data.kinds].map((k) => (
                  <li key={k.value ?? ''}>
                    <a href={slots.kindHref!(k.value)} aria-current={k.value === data.kind ? 'true' : undefined} style={{ ...LINK_TARGET, fontWeight: k.value === data.kind ? 700 : 400 }}>
                      {k.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          {data.videos.length ? (
            <VideoGrid videos={data.videos} slots={slots} />
          ) : (
            <Empty title={t.noVideos} body={t.noVideosBody} action={data.kind || data.topic ? { href: slots.paths.videos, label: t.allVideos } : undefined} />
          )}
          <Pages page={data.page} pages={data.pages} slots={slots} />
        </>
      )}
    </Frame>
  )
}

/** One video: the click-to-play player, who made it, and its description. */
export function VideoPage({ result, slots, loadOnClick = true }: { result: Result<VideoPageData>; slots: PageSlots; loadOnClick?: boolean }) {
  const t = words(slots)
  return (
    <Frame slots={slots} title={(d: VideoPageData) => d.video.title} result={result}>
      {({ video: v }) => (
        <article className="wl-video" style={{ maxWidth: '60rem' }}>
          <Player youtubeId={v.youtubeId} title={v.title} thumbnail={v.thumbnail} embeddable={v.embeddable} loadOnClick={loadOnClick} />
          <p style={{ display: 'flex', flexWrap: 'wrap', gap: '0 0.75rem', alignItems: 'center' }}>
            {v.creator ? (
              <a href={slots.paths.creator(v.creator.slug)} style={LINK_TARGET}>
                <span style={SR}>{t.by} </span>
                {v.creator.name}
              </a>
            ) : null}
            {v.publishedAt ? (
              <time dateTime={v.publishedAt}>
                <span style={SR}>{t.published} </span>
                {day(v.publishedAt, slots.locale)}
              </time>
            ) : null}
            {v.duration ? (
              <span>
                <span style={SR}>
                  {t.length} {clockWords(v.duration)}
                </span>
                <span aria-hidden="true">{clock(v.duration)}</span>
              </span>
            ) : null}
            {v.kindLabel ? <Badge>{v.kindLabel}</Badge> : null}
          </p>
          {v.description ? <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{v.description}</p> : null}
          <p>
            <a href={slots.paths.videos} style={LINK_TARGET}>
              {t.allVideos}
            </a>
          </p>
        </article>
      )}
    </Frame>
  )
}
