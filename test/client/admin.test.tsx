// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ReviewQueue, SyncNowButton, type ReviewQueueRow } from '../../src/client/index.js'

// The admin's two components: the curator's review queue and the Sync now button. A made-up fetch stands in for the
// plugin's routes; made-up videos.
afterEach(cleanup)

const row = (n: number, extra: Partial<ReviewQueueRow> = {}): ReviewQueueRow => ({
  id: `id${n}`,
  youtubeId: `abcDEF1234${n}`,
  title: `Made-up video ${n}`,
  creator: 'Made-up creator',
  publishedAt: '2026-11-01T00:00:00.000Z',
  duration: 725,
  thumbnail: `https://i.ytimg.com/vi/x${n}/hq.jpg`,
  description: 'Made-up description',
  kind: 'care',
  reason: 'Waiting for a curator’s yes',
  embeddable: true,
  ...extra,
})
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const styleOf = (el: Element) => (el as HTMLElement).style

describe('ReviewQueue', () => {
  it('lists each waiting video with two real, labeled buttons, big enough to tap, and says how many wait', () => {
    render(<ReviewQueue rows={[row(1), row(2)]} total={7} api="/api" kinds={[{ label: 'Care', value: 'care' }]} editBase="/admin/collections/videos" />)
    expect(screen.getByRole('heading', { level: 2, name: 'Waiting for review' })).toBeTruthy()
    expect(screen.getByText('7 videos wait for a yes.')).toBeTruthy()
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    for (const n of [1, 2]) {
      const article = screen.getByRole('article', { name: `Made-up video ${n}` })
      for (const name of [`Always show: Made-up video ${n}`, `Always hide: Made-up video ${n}`]) {
        const b = within(article).getByRole('button', { name })
        expect(b.tagName).toBe('BUTTON')
        expect(b.getAttribute('type')).toBe('button')
        expect(b.getAttribute('tabindex')).toBeNull()
        expect(b.hasAttribute('disabled')).toBe(false)
        expect(parseInt(styleOf(b).minHeight)).toBeGreaterThanOrEqual(44)
        expect(parseInt(styleOf(b).minWidth)).toBeGreaterThanOrEqual(44)
        // The visible words are part of the name, so speech input works.
        expect(name.startsWith(b.textContent!)).toBe(true)
      }
      expect(within(article).getByRole('link', { name: `Edit: Made-up video ${n}` }).getAttribute('href')).toBe(`/admin/collections/videos/id${n}`)
      expect(within(article).getByText(/Why it waits:/).parentElement!.textContent).toContain('Waiting for a curator’s yes')
      expect(within(article).getByText(/Made-up creator · Nov 1, 2026 · Care/)).toBeTruthy()
      expect(within(article).getByLabelText('12 minutes 5 seconds').textContent).toBe('12:05')
      // The video can be watched in place, and loads nothing from YouTube until asked.
      expect(within(article).getByRole('button', { name: `Play: Made-up video ${n}` })).toBeTruthy()
      expect(article.querySelector('iframe')).toBeNull()
    }
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a yes goes to the review route, is said in the live region, takes the video off the list and moves focus to the next one', async () => {
    const fetcher = vi.fn(async () => answer(200, { id: 'id1', choice: 'show', shown: true }))
    render(<ReviewQueue rows={[row(1), row(2)]} total={2} api="/api" collection="videos" fetcher={fetcher as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'Always show: Made-up video 1' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Always show: Made-up video 1. Saved.'))
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/videos/id1/review')
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', body: JSON.stringify({ choice: 'show' }) })
    expect(screen.queryByRole('article', { name: 'Made-up video 1' })).toBeNull()
    expect(screen.getByText('1 video waits for a yes.')).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Always show: Made-up video 2' })))
    // The last one: a no, then the empty state, and focus goes to the heading.
    fireEvent.click(screen.getByRole('button', { name: 'Always hide: Made-up video 2' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Always hide: Made-up video 2. Saved.'))
    expect(JSON.parse((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({ choice: 'hide' })
    expect(screen.getByText('Nothing waits for review here.')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 })))
  })

  it('a refusal is said in words as an alert, and the video stays', async () => {
    for (const [status, words] of [
      [409, 'Another curator has already decided on this video.'],
      [403, 'You can’t review this site’s videos.'],
      [401, 'You’re signed out. Sign in again, then retry.'],
      [500, 'Try again in a minute.'],
    ] as const) {
      const fetcher = vi.fn(async () => answer(status, status === 500 ? null : { errors: [{ message: 'made-up server words' }] }))
      render(<ReviewQueue rows={[row(1)]} total={1} api="/api" fetcher={fetcher as never} />)
      fireEvent.click(screen.getByRole('button', { name: 'Always show: Made-up video 1' }))
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toBe(`Not saved: Made-up video 1. ${words}`)
      expect(screen.getByRole('status').textContent).toBe('')
      expect(screen.getByRole('article', { name: 'Made-up video 1' })).toBeTruthy()
      expect(screen.getByText('1 video waits for a yes.')).toBeTruthy()
      cleanup()
    }
    const down = vi.fn(async () => Promise.reject(new Error('made-up network detail')))
    render(<ReviewQueue rows={[row(1)]} total={1} api="/api" fetcher={down as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'Always hide: Made-up video 1' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Not saved: Made-up video 1. The connection failed. Try again.')
  })

  it('one decision at a time: a second click while one is being saved sends nothing', async () => {
    let finish: (r: Response) => void = () => undefined
    const fetcher = vi.fn(() => new Promise<Response>((r) => (finish = r)))
    render(<ReviewQueue rows={[row(1), row(2)]} total={2} api="/api" fetcher={fetcher as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'Always show: Made-up video 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Always show: Made-up video 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Always hide: Made-up video 2' }))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toBe('Saving: Made-up video 1')
    expect(screen.getByRole('article', { name: 'Made-up video 1' }).getAttribute('aria-busy')).toBe('true')
    await act(async () => finish(answer(200, {})))
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Made-up video 1' })).toBeNull())
  })

  it('an empty queue says so; nothing is kept in the browser', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem')
    render(<ReviewQueue rows={[]} total={0} api="/api" />)
    expect(screen.getByText('0 videos wait for a yes.')).toBeTruthy()
    expect(screen.getByText('Nothing waits for review here.')).toBeTruthy()
    expect(set).not.toHaveBeenCalled()
    expect(document.cookie).toBe('')
    set.mockRestore()
  })
})

describe('SyncNowButton', () => {
  it('a creator that isn’t saved yet gets a plain line, and no button', () => {
    render(<SyncNowButton api="/api" />)
    expect(screen.getByText('Save the creator, then sync from here.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('posts to the creator’s sync route once, however many clicks, and says what happened', async () => {
    let finish: (r: Response) => void = () => undefined
    const fetcher = vi.fn(() => new Promise<Response>((r) => (finish = r)))
    render(<SyncNowButton id="c1" api="/api" collection="creators" fetcher={fetcher as never} />)
    const button = screen.getByRole('button', { name: 'Sync now' })
    expect(button.getAttribute('type')).toBe('button')
    expect(parseInt(styleOf(button).minHeight)).toBeGreaterThanOrEqual(44)
    fireEvent.click(button)
    fireEvent.click(button)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('/api/creators/c1/sync')
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ method: 'POST', credentials: 'include' })
    expect(screen.getByRole('button', { name: 'Syncing…' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('status').textContent).toMatch(/^Syncing: reading the whole channel/)
    await act(async () => finish(answer(200, { added: 3, passed: 2, review: 1, unavailable: 1, units: 6, stopped: 'cap' })))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('3 new, 2 passed the rules, 1 wait for review, 1 gone from YouTube. 6 API units. Today’s unit cap is reached; the next run continues. Reload to see the note.'))
    expect(screen.getByRole('button', { name: 'Sync now' }).getAttribute('aria-disabled')).toBe('false')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a refusal (already syncing, not allowed) is an alert in the server’s words; a dropped connection is said plainly', async () => {
    const busy = vi.fn(async () => answer(409, { errors: [{ message: 'This creator is syncing already. Try again in a few minutes.' }] }))
    render(<SyncNowButton id="c1" api="/api" fetcher={busy as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Not synced. This creator is syncing already. Try again in a few minutes.')
    expect(screen.getByRole('status').textContent).toBe('')
    cleanup()
    const down = vi.fn(async () => Promise.reject(new Error('made-up network detail')))
    render(<SyncNowButton id="c1" api="/api" fetcher={down as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Not synced. The sync didn’t run. Try again in a few minutes.')
  })
})
