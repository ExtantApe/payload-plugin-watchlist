'use client'

import { useRef, useState } from 'react'

import { TARGET } from '../ui.js'

export type SyncNowLabels = { button?: string; busy?: string; working?: string; saveFirst?: string; failed?: string; done?: (r: SyncNowAnswer) => string }
export type SyncNowAnswer = { added?: number; updated?: number; passed?: number; review?: number; unavailable?: number; returned?: number; units?: number; stopped?: 'cap' | 'site-cap' | 'quota' | null; note?: string }
export type SyncNowButtonProps = {
  /** The creator's id; without one (a creator not saved yet) the button isn't shown. */
  id?: string | number | null
  /** Payload's API route, e.g. `/api`. */
  api: string
  /** The creators collection's slug. */
  collection?: string
  labels?: SyncNowLabels
  /** The fetch to use; tests pass a fake. */
  fetcher?: typeof fetch
}

const summary = (r: SyncNowAnswer) =>
  `${r.added ?? 0} new, ${r.passed ?? 0} passed the rules, ${r.review ?? 0} wait for review${r.unavailable ? `, ${r.unavailable} gone from YouTube` : ''}${r.returned ? `, ${r.returned} back on YouTube` : ''}. ${r.units ?? 0} API units.${r.stopped === 'cap' ? ' Today’s unit cap is reached; the next run continues.' : r.stopped === 'site-cap' ? ' This site’s share of today’s units is used; the next run continues tomorrow.' : r.stopped === 'quota' ? ' YouTube’s daily quota is used up; the next run continues.' : ''} Reload to see the note.`

/**
 * "Sync now" in a creator's sidebar. One run at a time: the button is off while a run is going, and the server's lock
 * refuses a second one anyway. What happened is said in a live region, in words.
 */
export function SyncNowButton({ id, api, collection = 'creators', labels, fetcher }: SyncNowButtonProps) {
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ kind: 'status' | 'error'; message: string } | null>(null)
  const running = useRef(false)
  if (id === undefined || id === null || id === '') return <p>{labels?.saveFirst ?? 'Save the creator, then sync from here.'}</p>
  const run = async () => {
    if (running.current) return
    running.current = true
    setBusy(true)
    setSaid({ kind: 'status', message: labels?.working ?? 'Syncing: reading the whole channel and re-checking its videos. A big channel takes a minute or two.' })
    try {
      const res = await (fetcher ?? fetch)(`${api}/${collection}/${encodeURIComponent(String(id))}/sync`, { method: 'POST', credentials: 'include' })
      const body = (await res.json().catch(() => null)) as (SyncNowAnswer & { errors?: { message?: string }[] }) | null
      if (!res.ok) setSaid({ kind: 'error', message: body?.errors?.[0]?.message ?? labels?.failed ?? 'The sync didn’t run. Try again in a few minutes.' })
      else setSaid({ kind: 'status', message: labels?.done ? labels.done(body ?? {}) : summary(body ?? {}) })
    } catch {
      setSaid({ kind: 'error', message: labels?.failed ?? 'The sync didn’t run. Try again in a few minutes.' })
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return (
    <div data-watchlist-sync-now style={{ marginBottom: 'var(--base, 1rem)' }}>
      <button type="button" className="btn btn--style-primary btn--size-medium" style={{ ...TARGET, margin: 0 }} aria-disabled={busy} onClick={run}>
        {busy ? (labels?.busy ?? 'Syncing…') : (labels?.button ?? 'Sync now')}
      </button>
      <p role="status" aria-live="polite" style={{ marginTop: 6 }}>
        {said?.kind === 'status' ? said.message : ''}
      </p>
      {said?.kind === 'error' ? (
        <p role="alert" style={{ marginTop: 6 }}>
          <strong>Not synced.</strong> {said.message}
        </p>
      ) : null}
    </div>
  )
}
