'use client'

import { useEffect, useRef, useState } from 'react'

import { clock, clockWords, day, TARGET } from '../ui.js'
import { Player } from './Player.js'

/** A waiting video, as `reviewQueue` (from `/server`) gives it. */
export type ReviewQueueRow = {
  id: string
  youtubeId: string
  title: string
  creator: string
  publishedAt: string | null
  duration: number | null
  thumbnail: string | null
  description: string
  kind: string | null
  reason: string | null
  embeddable: boolean | null
}
export type ReviewQueueLabels = {
  heading?: string
  waiting?: (n: number) => string
  empty?: string
  show?: string
  hide?: string
  shown?: (title: string) => string
  hidden?: (title: string) => string
  failed?: (title: string, why: string) => string
  saving?: (title: string) => string
  edit?: string
}
export type ReviewQueueProps = {
  rows: ReviewQueueRow[]
  /** How many wait in all (the page may show fewer). */
  total: number
  /** Payload's API route, e.g. `/api`. */
  api: string
  /** The videos collection's slug. */
  collection?: string
  /** Where "Edit" goes: this path with the video's id after it, e.g. `/admin/collections/videos`. Left out, there's no Edit link. */
  editBase?: string
  kinds?: { label: string; value: string }[]
  labels?: ReviewQueueLabels
  /** The fetch to use; tests pass a fake. */
  fetcher?: typeof fetch
}

const WHY: Record<number, string> = {
  401: 'You’re signed out. Sign in again, then retry.',
  403: 'You can’t review this site’s videos.',
  404: 'That video is gone from the queue.',
  409: 'Another curator has already decided on this video.',
}

/**
 * The curator's review queue: each waiting video with two real buttons, "Always show" and "Always hide", named with
 * the video's title. Every decision goes through the plugin's review route (`reviewVideo`, with its atomic claim), is
 * said in a live region, and takes the video off the list; focus then moves to the next video's first button, or to the
 * heading when none are left. A refusal is said in words and the video stays.
 */
export function ReviewQueue({ rows: initial, total: initialTotal, api, collection = 'videos', editBase, kinds, labels, fetcher }: ReviewQueueProps) {
  const [rows, setRows] = useState(initial)
  const [total, setTotal] = useState(initialTotal)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [problem, setProblem] = useState('')
  const [focusOn, setFocusOn] = useState<string | 'heading' | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const running = useRef(false)

  useEffect(() => {
    if (!focusOn) return
    if (focusOn === 'heading') heading.current?.focus()
    else list.current?.querySelector<HTMLButtonElement>(`[data-video="${focusOn}"] button[data-choice="show"]`)?.focus()
    setFocusOn(null)
  }, [focusOn])

  const decide = async (row: ReviewQueueRow, choice: 'show' | 'hide') => {
    if (running.current) return
    running.current = true
    setBusy(row.id)
    setProblem('')
    setStatus(labels?.saving ? labels.saving(row.title) : `Saving: ${row.title}`)
    try {
      const res = await (fetcher ?? fetch)(`${api}/${collection}/${encodeURIComponent(row.id)}/review`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice }),
      })
      const body = (await res.json().catch(() => null)) as { errors?: { message?: string }[] } | null
      if (!res.ok) {
        const why = WHY[res.status] ?? body?.errors?.[0]?.message ?? 'Try again in a minute.'
        setStatus('')
        setProblem(labels?.failed ? labels.failed(row.title, why) : `Not saved: ${row.title}. ${why}`)
        return
      }
      const at = rows.findIndex((r) => r.id === row.id)
      const left = rows.filter((r) => r.id !== row.id)
      setRows(left)
      setTotal((n) => Math.max(0, n - 1))
      setStatus(choice === 'show' ? (labels?.shown ? labels.shown(row.title) : `Always show: ${row.title}. Saved.`) : labels?.hidden ? labels.hidden(row.title) : `Always hide: ${row.title}. Saved.`)
      setFocusOn(left.length ? (left[Math.min(at, left.length - 1)]!.id) : 'heading')
    } catch {
      setStatus('')
      setProblem(labels?.failed ? labels.failed(row.title, 'The connection failed.') : `Not saved: ${row.title}. The connection failed. Try again.`)
    } finally {
      running.current = false
      setBusy(null)
    }
  }

  const kindLabel = (k: string | null) => (k ? (kinds?.find((x) => x.value === k)?.label ?? k) : null)
  const showText = labels?.show ?? 'Always show'
  const hideText = labels?.hide ?? 'Always hide'

  return (
    <section aria-labelledby="playlists-review-heading" data-playlists-review>
      <h2 id="playlists-review-heading" ref={heading} tabIndex={-1}>
        {labels?.heading ?? 'Waiting for review'}
      </h2>
      <p data-playlists-count>{labels?.waiting ? labels.waiting(total) : total === 1 ? '1 video waits for a yes.' : `${total} videos wait for a yes.`}</p>
      <p role="status" aria-live="polite" data-playlists-status>
        {status}
      </p>
      {problem ? (
        <p role="alert" data-playlists-problem>
          {problem}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p data-playlists-empty>{labels?.empty ?? 'Nothing waits for review here.'}</p>
      ) : (
        <ul ref={list} style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '1.5rem' }}>
          {rows.map((row) => {
            const titleId = `playlists-review-${row.id}`
            const facts = [row.creator, day(row.publishedAt), kindLabel(row.kind)].filter(Boolean)
            return (
              <li key={row.id} data-video={row.id}>
                <article aria-labelledby={titleId} aria-busy={busy === row.id} style={{ display: 'grid', gap: '0.5rem', gridTemplateColumns: 'minmax(0, 1fr)', maxWidth: '40rem' }}>
                  <h3 id={titleId} style={{ margin: 0 }}>
                    {row.title}
                  </h3>
                  <p style={{ margin: 0 }}>
                    {facts.join(' · ')}
                    {row.duration ? (
                      <>
                        {facts.length ? ' · ' : ''}
                        <span aria-label={clockWords(row.duration)}>{clock(row.duration)}</span>
                      </>
                    ) : null}
                  </p>
                  {row.reason ? (
                    <p style={{ margin: 0 }}>
                      <strong>Why it waits:</strong> {row.reason}
                    </p>
                  ) : null}
                  <Player youtubeId={row.youtubeId} title={row.title} thumbnail={row.thumbnail} embeddable={row.embeddable} />
                  {row.description ? (
                    <details>
                      <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center', cursor: 'pointer' }}>Description</summary>
                      <p style={{ whiteSpace: 'pre-wrap' }}>{row.description}</p>
                    </details>
                  ) : null}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
                    <button type="button" data-choice="show" className="btn btn--style-primary btn--size-medium" style={{ ...TARGET, margin: 0 }} aria-label={`${showText}: ${row.title}`} aria-disabled={busy !== null} onClick={() => void decide(row, 'show')}>
                      {showText}
                    </button>
                    <button type="button" data-choice="hide" className="btn btn--style-secondary btn--size-medium" style={{ ...TARGET, margin: 0 }} aria-label={`${hideText}: ${row.title}`} aria-disabled={busy !== null} onClick={() => void decide(row, 'hide')}>
                      {hideText}
                    </button>
                    {editBase ? (
                      <a href={`${editBase}/${encodeURIComponent(row.id)}`} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, minWidth: 44 }} aria-label={`${labels?.edit ?? 'Edit'}: ${row.title}`}>
                        {labels?.edit ?? 'Edit'}
                      </a>
                    ) : null}
                  </div>
                </article>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
