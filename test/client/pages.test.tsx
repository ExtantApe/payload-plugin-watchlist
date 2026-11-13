// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { readdirSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CreatorListPage, CreatorPage, VideoPage, VideosPage, type PageSlots } from '../../src/pages/index.js'
import type { CreatorCard, VideoCard } from '../../src/server/index.js'

// The public pages, drawn from made-up answers of the server functions: real headings, lists and links, 44-pixel
// targets, nothing said by color alone, the site's slots, and nothing kept in the browser.
afterEach(cleanup)

const paths: PageSlots['paths'] = { videos: '/watch', creator: (s) => `/watch/c/${s}`, video: (id) => `/watch/v/${id}` }
const slots: PageSlots = { paths, pageHref: (n) => `/watch?page=${n}`, kindHref: (k) => (k ? `/watch?kind=${k}` : '/watch') }
const creator: CreatorCard = { id: 'c1', name: 'Made-up Alpha', slug: 'made-up-alpha', bio: 'Made-up bio', avatar: 'https://yt3.ggpht.com/made-up', website: 'https://example.test/alpha', channels: [{ handle: '@alpha', title: 'Alpha channel', channelId: 'UCxxxxxxxxxxxxxxxxxxxxxx' }] }
const video = (n: number, extra: Partial<VideoCard> = {}): VideoCard => ({ id: `v${n}`, youtubeId: `abcDEF1234${n}`, title: `Made-up video ${n}`, publishedAt: '2026-11-01T00:00:00.000Z', duration: 3725, thumbnail: `https://i.ytimg.com/vi/x${n}/hq.jpg`, kind: 'care', kindLabel: 'Care', embeddable: true, creator: { id: 'c1', name: 'Made-up Alpha', slug: 'made-up-alpha' }, ...extra })
const kinds = [
  { label: 'Care', value: 'care' },
  { label: 'Build', value: 'build' },
]
const px = (el: Element, prop: 'minHeight' | 'minWidth') => parseInt((el as HTMLElement).style[prop])

describe('the video grid page', () => {
  it('one main, one h1, a list of cards that link to each video and creator, with dates and lengths in words', () => {
    render(<VideosPage result={{ videos: [video(1), video(2, { kindLabel: 'Build', kind: 'build' })], page: 2, pages: 3, total: 50, kinds, kind: 'care', topic: null }} slots={slots} />)
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: 'Watch' })).toBeTruthy()
    const grid = document.querySelector('ul.wl-grid')!
    expect(grid.getAttribute('style')).toContain('grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr))')
    const cards = within(grid as HTMLElement).getAllByRole('article')
    expect(cards).toHaveLength(2)
    const first = within(cards[0]!)
    const link = first.getByRole('link', { name: 'Made-up video 1' })
    expect(link.getAttribute('href')).toBe('/watch/v/abcDEF12341')
    expect(px(link, 'minHeight')).toBeGreaterThanOrEqual(44)
    expect(first.getByRole('heading', { level: 2, name: 'Made-up video 1' })).toBeTruthy()
    // The thumbnail is decoration beside its title; it comes from YouTube's image host only.
    const img = cards[0]!.querySelector('img')!
    expect(img.getAttribute('alt')).toBe('')
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(new URL(img.src).host).toBe('i.ytimg.com')
    const by = first.getByRole('link', { name: 'By Made-up Alpha' })
    expect(by.getAttribute('href')).toBe('/watch/c/made-up-alpha')
    expect(px(by, 'minHeight')).toBeGreaterThanOrEqual(44)
    expect(px(by, 'minWidth')).toBeGreaterThanOrEqual(44)
    const time = cards[0]!.querySelector('time')!
    expect(time.getAttribute('datetime')).toBe('2026-11-01T00:00:00.000Z')
    expect(time.textContent).toBe('Published Nov 1, 2026')
    expect(cards[0]!.textContent).toContain('Length 1 hour 2 minutes 5 seconds')
    expect(cards[0]!.textContent).toContain('1:02:05')
    // The kind is said in words, with a border, not by color.
    const badge = cards[1]!.querySelector('.wl-badge') as HTMLElement
    expect(badge.textContent).toBe('Build')
    expect(badge.style.borderStyle).toBe('solid')
    expect(badge.style.color).toBe('')
    expect(badge.style.background).toBe('')
  })

  it('the kind filter and the page links are real links in named navs, with the current one marked in more than weight', () => {
    render(<VideosPage result={{ videos: [video(1)], page: 2, pages: 3, total: 50, kinds, kind: 'care', topic: null }} slots={slots} />)
    const type = screen.getByRole('navigation', { name: 'Type' })
    const links = within(type).getAllByRole('link')
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['All types', '/watch'],
      ['Care', '/watch?kind=care'],
      ['Build', '/watch?kind=build'],
    ])
    expect(links[1]!.getAttribute('aria-current')).toBe('true')
    expect(links[0]!.getAttribute('aria-current')).toBeNull()
    for (const l of links) expect(px(l, 'minHeight')).toBeGreaterThanOrEqual(44)
    const pages = screen.getByRole('navigation', { name: 'Pages' })
    expect(within(pages).getByRole('link', { name: 'Newer videos' }).getAttribute('href')).toBe('/watch?page=1')
    expect(within(pages).getByRole('link', { name: 'Older videos' }).getAttribute('href')).toBe('/watch?page=3')
    expect(within(pages).getByText('Page 2 of 3').getAttribute('aria-current')).toBe('page')
    for (const l of within(pages).getAllByRole('link')) expect(px(l, 'minHeight')).toBeGreaterThanOrEqual(44)
  })

  it('first and last pages leave out the link that goes nowhere; one page has no page links at all', () => {
    const { unmount } = render(<VideosPage result={{ videos: [video(1)], page: 1, pages: 2, total: 30, kinds, kind: null, topic: null }} slots={slots} />)
    expect(screen.queryByRole('link', { name: 'Newer videos' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Older videos' })).toBeTruthy()
    unmount()
    render(<VideosPage result={{ videos: [video(1)], page: 1, pages: 1, total: 1, kinds, kind: null, topic: null }} slots={slots} />)
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull()
  })

  it('the site’s slots: its shell, its empty state and its topic filter', () => {
    const Shell = ({ title, children }: { title: string; children: React.ReactNode }) => (
      <main data-site-shell>
        <h1>Site: {title}</h1>
        {children}
      </main>
    )
    const Empty = ({ title, action }: { title: string; action?: { href: string; label: string } }) => (
      <p data-site-empty>
        {title} {action ? <a href={action.href}>{action.label}</a> : null}
      </p>
    )
    const TopicFilter = ({ topic, kind }: { topic: string | null; kind: string | null }) => <form aria-label="Topic" data-topic={topic ?? ''} data-kind={kind ?? ''} />
    render(<VideosPage result={{ videos: [], page: 1, pages: 1, total: 0, kinds, kind: 'care', topic: 't1' }} slots={{ ...slots, Shell, Empty, TopicFilter, text: { watch: 'Videos to watch', noVideos: 'Rien ici' } }} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Site: Videos to watch' })).toBeTruthy()
    expect(document.querySelector('[data-site-shell]')).toBeTruthy()
    const filter = screen.getByRole('form', { name: 'Topic' })
    expect(filter.getAttribute('data-topic')).toBe('t1')
    expect(filter.getAttribute('data-kind')).toBe('care')
    expect(document.querySelector('[data-site-empty]')!.textContent).toContain('Rien ici')
    expect(screen.getByRole('link', { name: 'All videos' }).getAttribute('href')).toBe('/watch')
    expect(screen.queryByRole('list', { name: '' })?.classList.contains('wl-grid') ?? false).toBe(false)
  })

  it('the default empty state, and a refusal or failure shown as an alert in plain words', () => {
    const { unmount } = render(<VideosPage result={{ videos: [], page: 1, pages: 1, total: 0, kinds: [], kind: null, topic: null }} slots={{ paths }} />)
    expect(screen.getByRole('note').textContent).toContain('No videos yet')
    unmount()
    render(<VideosPage result={{ error: { code: 'generic', message: 'Something went wrong on our side. Please try again in a minute.' } }} slots={{ paths }} />)
    expect(screen.getByRole('alert').textContent).toBe('Something went wrong on our side. Please try again in a minute.')
    expect(screen.getByRole('heading', { level: 1, name: 'Watch' })).toBeTruthy()
    expect(document.querySelector('.wl-grid')).toBeNull()
  })
})

describe('the creator list and a creator’s page', () => {
  it('the list: each creator a card with a link to their page, their site and their channel', () => {
    render(<CreatorListPage result={{ creators: [creator, { ...creator, id: 'c2', name: 'Made-up Beta', slug: 'made-up-beta', avatar: null, bio: null, website: null, channels: [] }] }} slots={slots} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Creators' })).toBeTruthy()
    const cards = screen.getAllByRole('article')
    expect(cards).toHaveLength(2)
    const a = within(cards[0]!)
    expect(a.getByRole('heading', { level: 2, name: 'Made-up Alpha' })).toBeTruthy()
    expect(a.getByRole('link', { name: 'Made-up Alpha' }).getAttribute('href')).toBe('/watch/c/made-up-alpha')
    expect(cards[0]!.querySelector('img')!.getAttribute('alt')).toBe('')
    const site = a.getByRole('link', { name: /^Website ?: Made-up Alpha$/ })
    expect(site.getAttribute('href')).toBe('https://example.test/alpha')
    expect(site.getAttribute('rel')).toContain('noopener')
    expect(a.getByRole('link', { name: 'Alpha channel on YouTube' }).getAttribute('href')).toBe('https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx')
    for (const l of a.getAllByRole('link')) expect(px(l, 'minHeight')).toBeGreaterThanOrEqual(44)
    expect(within(cards[1]!).getAllByRole('link')).toHaveLength(1)
    expect(cards[1]!.querySelector('img')).toBeNull()
  })

  it('no creators: the empty state', () => {
    render(<CreatorListPage result={{ creators: [] }} slots={slots} />)
    expect(screen.getByRole('note').textContent).toContain('No creators yet')
  })

  it('a creator’s page: their name as the h1, their videos under an h2 with h3 cards, and no link back to themselves on each card', () => {
    render(<CreatorPage result={{ creator, videos: [video(1), video(2)], page: 1, pages: 2, total: 30 }} slots={slots} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Made-up Alpha' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: 'Videos' })).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2)
    expect(screen.queryByRole('link', { name: 'By Made-up Alpha' })).toBeNull()
    expect(screen.getByText('Made-up bio')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Older videos' })).toBeTruthy()
  })

  it('a creator that isn’t there: the plain message, not a broken page', () => {
    render(<CreatorPage result={{ error: { code: 'notFound', message: 'We couldn’t find that. It may have been removed, or the link may be wrong.' } }} slots={slots} />)
    expect(screen.getByRole('alert').textContent).toContain('We couldn’t find that.')
    expect(screen.queryByRole('article')).toBeNull()
  })
})

describe('a video’s page', () => {
  const data = { video: { ...video(1), description: 'Made-up words\nover two lines', topics: [] } }
  it('the title as the h1 and the click-to-play player: nothing loads from YouTube until the button is pressed', () => {
    const { container } = render(<VideoPage result={data} slots={slots} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Made-up video 1' })).toBeTruthy()
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    for (const img of container.querySelectorAll('img')) expect(new URL(img.src).host).toBe('i.ytimg.com')
    fireEvent.click(screen.getByRole('button', { name: 'Play: Made-up video 1' }))
    const frame = container.querySelector('iframe')!
    expect(new URL(frame.src).origin).toBe('https://www.youtube-nocookie.com')
    expect(frame.title).toBe('Made-up video 1')
    expect(screen.getByRole('link', { name: 'By Made-up Alpha' }).getAttribute('href')).toBe('/watch/c/made-up-alpha')
    expect(screen.getByRole('link', { name: 'All videos' }).getAttribute('href')).toBe('/watch')
    expect(screen.getByText(/Made-up words/)).toBeTruthy()
  })

  it('a video YouTube won’t let be embedded links out; a hidden one shows the plain message', () => {
    const { container, unmount } = render(<VideoPage result={{ video: { ...data.video, embeddable: false } }} slots={slots} />)
    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('link', { name: 'Watch on YouTube' })).toBeTruthy()
    unmount()
    render(<VideoPage result={{ error: { code: 'notFound', message: 'We couldn’t find that.' } }} slots={slots} />)
    expect(screen.getByRole('alert').textContent).toBe('We couldn’t find that.')
  })
})

describe('nothing is kept in the browser', () => {
  it('drawing and using every page touches no web storage and sets no cookie', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem')
    const get = vi.spyOn(Storage.prototype, 'getItem')
    render(<VideosPage result={{ videos: [video(1)], page: 1, pages: 2, total: 30, kinds, kind: null, topic: null }} slots={slots} />)
    render(<CreatorListPage result={{ creators: [creator] }} slots={slots} />)
    render(<CreatorPage result={{ creator, videos: [video(2)], page: 1, pages: 1, total: 1 }} slots={slots} />)
    render(<VideoPage result={{ video: { ...video(3), description: '', topics: [] } }} slots={slots} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play: Made-up video 3' }))
    expect(set).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    expect(document.cookie).toBe('')
    set.mockRestore()
    get.mockRestore()
  })

  it('no page, component or server function names web storage, cookies or IndexedDB', () => {
    const files = ['pages', 'client', 'server', 'rsc'].flatMap((d) => readdirSync(`src/${d}`).map((f) => `src/${d}/${f}`)).concat('src/ui.ts')
    expect(files.length).toBeGreaterThan(10)
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./)
  })
})
