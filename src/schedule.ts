/**
 * When each creator is checked: daily at the default hour in the site's time zone, unless a curator picks days and an
 * hour. The site's cron runs hourly and syncs the creators that are due: a scheduled moment has passed since the last
 * sync, so a missed run catches up at the next one. Weekly re-check, monthly full read, and a 15-minute run lock.
 */
export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export type Day = (typeof DAYS)[number]
const HOUR_MS = 3600_000
export const RECHECK_EVERY_MS = 7 * 24 * HOUR_MS
export const FULL_EVERY_MS = 30 * 24 * HOUR_MS
export const SYNC_LOCK_MS = 15 * 60_000

export type Schedule = { syncDays?: (Day | string)[] | null; syncHour?: number | null }

/** The zone's offset from UTC at `at`, in ms (positive east of UTC). */
export function offsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  )
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** A wall-clock time in a zone, as a UTC instant. */
function wallToUtc(y: number, m: number, d: number, hour: number, timeZone: string): Date {
  const guess = Date.UTC(y, m, d, hour)
  let t = guess - offsetMs(new Date(guess), timeZone)
  t = guess - offsetMs(new Date(t), timeZone)
  return new Date(t)
}

const hourOf = (s: Schedule, defaultHour: number) => (typeof s.syncHour === 'number' && Number.isInteger(s.syncHour) && s.syncHour >= 0 && s.syncHour <= 23 ? s.syncHour : defaultHour)
const daysOf = (s: Schedule): readonly string[] => (Array.isArray(s.syncDays) && s.syncDays.length ? s.syncDays.filter((d) => (DAYS as readonly string[]).includes(d)) : DAYS)

/** The latest scheduled moment at or before `now` (within eight days), or null when none is set. */
export function lastSlot(now: Date, s: Schedule, timeZone = 'UTC', defaultHour = 12): Date | null {
  const days = daysOf(s)
  if (!days.length) return null
  const local = new Date(now.getTime() + offsetMs(now, timeZone)) // wall-clock, read with the UTC getters
  for (let back = 0; back <= 8; back++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - back))
    const slot = wallToUtc(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hourOf(s, defaultHour), timeZone)
    if (slot <= now && days.includes(DAYS[day.getUTCDay()]!)) return slot
  }
  return null
}

export function isDue(now: Date, s: Schedule & { lastSyncedAt?: string | Date | null }, timeZone = 'UTC', defaultHour = 12): boolean {
  const slot = lastSlot(now, s, timeZone, defaultHour)
  if (!slot) return false
  const last = s.lastSyncedAt ? new Date(s.lastSyncedAt) : null
  return !last || Number.isNaN(last.getTime()) || last < slot
}

const older = (now: Date, at: string | Date | null | undefined, ms: number) => !at || Number.isNaN(new Date(at).getTime()) || now.getTime() - new Date(at).getTime() >= ms
export const recheckDue = (now: Date, lastRecheckAt?: string | Date | null) => older(now, lastRecheckAt, RECHECK_EVERY_MS)
export const fullDue = (now: Date, lastFullSyncAt?: string | Date | null) => older(now, lastFullSyncAt, FULL_EVERY_MS)
