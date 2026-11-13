// Small shared pieces for the pages and the admin components. No Node imports and no hooks, so both the server pages
// and the browser components can use them.
import type { CSSProperties } from 'react'

/** At least 44 by 44 CSS pixels: every button and link the plugin draws. */
export const TARGET: CSSProperties = { minHeight: 44, minWidth: 44, padding: '0.5rem 1rem', boxSizing: 'border-box', font: 'inherit', cursor: 'pointer' }
export const LINK_TARGET: CSSProperties = { display: 'inline-flex', alignItems: 'center', minHeight: 44, minWidth: 44, padding: '0.25rem 0', boxSizing: 'border-box' }

/** "12:05" or "1:02:03"; empty when unknown. */
export const clock = (s?: number | null): string => {
  if (!s || s < 0) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(Math.floor(s % 60)).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** The same length in words, for screen readers: "12 minutes 5 seconds". */
export const clockWords = (s?: number | null): string => {
  if (!s || s < 0) return ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const part = (n: number, word: string) => (n ? `${n} ${word}${n === 1 ? '' : 's'}` : '')
  return [part(h, 'hour'), part(m, 'minute'), part(sec, 'second')].filter(Boolean).join(' ')
}

/** A date in words, the same on the server and in the browser (UTC), or empty. */
export const day = (iso: string | null | undefined, locale = 'en-US'): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(d)
  } catch {
    return d.toISOString().slice(0, 10)
  }
}
