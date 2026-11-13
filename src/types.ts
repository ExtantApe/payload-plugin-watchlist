import type { CollectionConfig, Field, PayloadRequest } from 'payload'

export type SiteId = string | number

/** A site's answer that may be async. */
type Maybe<T> = T | Promise<T>

/**
 * Who belongs to which site, and who may do what. The plugin builds every query itself from these answers: a provider
 * never hands back a query that's passed through.
 *
 * Each answer must be exactly what's asked for. `isAdmin` passes only on `true`; `sitesFor` counts only when it's an
 * array (of strings or numbers); `ofRequest` counts only when it's a string or a number. Anything else, a thrown error
 * included, is a no.
 */
export type ScopeProvider = {
  /** The field that holds a record's site, e.g. `tenant`, added by the site's multi-tenant plugin. Leave it out on a single-site install. */
  field?: string
  /** The visitor's site. `null` means nothing is publicly readable. Not needed without `field`. */
  ofRequest?: (req: PayloadRequest) => Maybe<SiteId | null>
  /** The sites where this person may curate (review videos) or edit (manage creators and videos). Without `field`, any non-empty array means "yes". */
  sitesFor: (req: PayloadRequest, role: 'curate' | 'edit') => Maybe<SiteId[]>
  /** A platform admin: everything, every site. */
  isAdmin: (req: PayloadRequest) => Maybe<boolean>
}

/** What the site's classifier says about one video. */
export type Classified = {
  /** One of `kinds`. */
  kind: string
  /** `false` when the video isn't about the site's subject (the site's own rule). Anything but `false` is "about it". */
  relevant?: boolean
  /** Names of the topics the video is about (e.g. scientific names), resolved by `topics.resolve`. */
  topics?: string[]
  /** The whole video is about one topic. */
  singleTopic?: boolean
}

/**
 * What the classifier is given for each video: titles and descriptions only (the owner, 2026-11-11),
 * with the channel's public name. No thumbnails, no comments, nothing about visitors.
 */
export type ClassifyInput = { key: string; title: string; description: string; channel: string }

export type ClassifyHook = (videos: ClassifyInput[], ctx: { req: PayloadRequest }) => Promise<Map<string, Classified>>

/** A message for the site's notifications (or Notifications plugin). */
export type WatchlistNotice =
  | { kind: 'watchlist.review'; site: SiteId | null; waiting: number; urgent: boolean }
  | { kind: 'watchlist.sync-problem'; site: SiteId | null; creator: string; problem: 'quota' | 'cap' | 'site-cap' | 'channel-not-found' | 'error'; note: string }

export type TopicsOption = {
  /** The collection a video's topics point at, e.g. `taxa`. */
  relationTo: string
  /** Field names on videos (the site's own names are kept). */
  field?: string
  stateField?: string
  namesField?: string
  /** Field names on a creator's channels. */
  modeField?: string
  titlesField?: string
  /** The playlist rule value that puts a playlist's videos on topic pages automatically. */
  playlistRule?: string
  filterOptions?: Record<string, unknown>
  /** A topic id for a name the classifier gave, or null. */
  resolve: (name: string, req: PayloadRequest) => Maybe<SiteId | null>
}

export type Option = { label: string; value: string }

/** How the curator's yes is set: per creator (the owner, 2026-11-11), or per channel. */
export type CurationLevel = 'creator' | 'channel'
/**
 * Gone videos: keep their details, or clear YouTube's details after a grace period. The owner chose (2026-11-11)
 * to clear them if YouTube's terms call for it. The terms haven't been read yet, so the default stays `keep`.
 */
export type GoneVideos = 'keep' | 'clear'

export type CollectionOverride = (collection: CollectionConfig) => CollectionConfig

export type WatchlistOptions = {
  collections?: { creators?: string; videos?: string; usage?: string }
  overrides?: { creators?: CollectionOverride; videos?: CollectionOverride; usage?: CollectionOverride }
  scope: ScopeProvider
  youtube?: {
    /** The Data API key. The plugin never reads `process.env`. `null` means RSS-only. */
    apiKey?: (req: PayloadRequest) => Maybe<string | null>
    /** Units a day across every site, well under YouTube's quota. Default 2,000. */
    dailyUnitCap?: number
    /**
     * One site's share of the day's units, for every run of that site (the cron's and Sync now), so one site can't
     * spend every site's units. Left out, a site may use up to the whole cap.
     */
    siteDailyUnitCap?: number
    /** The zone YouTube's daily quota resets in (unverified: Pacific). Default `America/Los_Angeles`. */
    quotaTimeZone?: string
    /** Read each channel's public feed before any API call. Default true. Turn off if YouTube's terms or robots.txt say no. */
    rss?: boolean
    /** The fetch to use; tests pass a fake. Default the global fetch. */
    fetch?: typeof fetch
    /** Waits between retries; tests pass a fake. */
    sleep?: (ms: number) => Promise<void>
  }
  /** Outside calls allowed (YouTube, RSS, notifications). Only an exact `true` allows any. */
  enabled: (req: PayloadRequest) => Maybe<boolean>
  schedule?: { timeZone?: string; defaultHour?: number }
  /** A new creator's "Which videos". Default `picked`: a new creator's videos wait for a curator's yes, and a curator can set a trusted creator to `rules` (the owner, 2026-11-11). A stored creator with no value counts as `picked`. */
  defaults?: { videosDefault?: 'rules' | 'picked' }
  curation?: {
    level?: CurationLevel
    /** Videos waiting past this many send the digest at once. Default 25 (the site's team, 2026-11-11). */
    urgentAt?: number
  }
  goneVideos?: { mode?: GoneVideos; clearAfterDays?: number }
  /** Sync now: minutes a creator rests after any sync before a person can start another. Default 10; 0 turns it off. */
  syncNow?: { cooldownMinutes?: number }
  kinds?: Option[]
  shownKinds?: string[]
  topicKinds?: string[]
  topics?: TopicsOption
  classify?: ClassifyHook
  /** How much of each description the classifier gets. Default 700 characters; 0 sends titles only. */
  classifyDescriptionChars?: number
  /** The site's cache: called after a sync or a person's change. */
  revalidate?: (args: { site: SiteId | null; tag: 'creators' | 'videos' }) => void
  notify?: (notice: WatchlistNotice, ctx: { req: PayloadRequest }) => Promise<void>
  labels?: { group?: string; listed?: string }
  /**
   * The admin's review view and its nav link. `reviewPath` is where it lives under the admin route (default
   * `/watchlist-review`). `false` leaves both out; the Sync now button and the two routes stay.
   */
  admin?: { reviewPath?: string } | false
  ensureIndexes?: 'startup' | 'manual'
}

export type ResolvedOptions = WatchlistOptions & {
  collections: { creators: string; videos: string; usage: string }
  kinds: Option[]
  shownKinds: string[]
  topicKinds: string[]
  curationLevel: CurationLevel
  urgentAt: number
  goneMode: GoneVideos
  clearAfterDays: number
  dailyUnitCap: number
  siteDailyUnitCap: number | null
  syncNowCooldownMs: number
  quotaTimeZone: string
  rss: boolean
  timeZone: string
  defaultHour: number
  videosDefault: 'rules' | 'picked'
  descriptionChars: number
  adminReviewPath: string
}

export type { Field }
