import type { Config, Plugin } from 'payload'

import { creatorsCollection, PACKAGE, usageCollection, videosCollection } from './collections.js'
import { functionsOf, protect } from './protect.js'
import type { Option, ResolvedOptions, WatchlistOptions } from './types.js'

/** A short neutral list; a site passes its own. */
export const DEFAULT_KINDS: Option[] = [
  { label: 'Explainer', value: 'explainer' },
  { label: 'How-to', value: 'how-to' },
  { label: 'Field trip', value: 'field' },
  { label: 'Review', value: 'review' },
  { label: 'Vlog', value: 'vlog' },
  { label: 'Other', value: 'other' },
]
export const DEFAULT_SHOWN_KINDS = ['explainer', 'how-to', 'field']

const fail = (message: string): never => {
  throw new Error(`Watchlist: ${message}`)
}
const isFn = (v: unknown) => typeof v === 'function'
const isZone = (z: unknown) => {
  if (typeof z !== 'string' || !z) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z })
    return true
  } catch {
    return false
  }
}

export function checkOptions(options: WatchlistOptions, config: Config): ResolvedOptions {
  if (!options || typeof options !== 'object') fail('watchlist() needs its options: scope and enabled at least.')
  const { scope } = options
  if (!scope || typeof scope !== 'object') fail('`scope` is required: { field?, ofRequest?, sitesFor, isAdmin }.')
  if (!isFn(scope.sitesFor) || !isFn(scope.isAdmin)) fail('`scope.sitesFor` and `scope.isAdmin` must be functions.')
  if (scope.field !== undefined && (typeof scope.field !== 'string' || !scope.field)) fail('`scope.field` must name the field that holds a record’s site, or be left out.')
  if (scope.field && !isFn(scope.ofRequest)) fail('`scope.ofRequest` must be a function (req) => the visitor’s site, or null.')
  if (!isFn(options.enabled)) fail('`enabled` is required: (req) => boolean, whether outside calls are allowed.')
  const yt = options.youtube ?? {}
  if (yt.apiKey !== undefined && !isFn(yt.apiKey)) fail('`youtube.apiKey` must be a function (req) => the key, or null. The plugin never reads the environment.')
  const cap = yt.dailyUnitCap ?? 2000
  if (!(Number.isInteger(cap) && cap > 0)) fail('`youtube.dailyUnitCap` must be a whole number above 0.')
  const siteCap = yt.siteDailyUnitCap ?? null
  if (siteCap !== null && !(Number.isInteger(siteCap) && siteCap > 0 && siteCap <= cap)) fail('`youtube.siteDailyUnitCap` must be a whole number above 0 and no more than `youtube.dailyUnitCap`.')
  const cooldown = options.syncNow?.cooldownMinutes ?? 10
  if (!(Number.isInteger(cooldown) && cooldown >= 0)) fail('`syncNow.cooldownMinutes` must be a whole number, 0 or more.')
  const quotaTimeZone = yt.quotaTimeZone ?? 'America/Los_Angeles'
  const timeZone = options.schedule?.timeZone ?? 'UTC'
  if (!isZone(quotaTimeZone) || !isZone(timeZone)) fail('`youtube.quotaTimeZone` and `schedule.timeZone` must be IANA time zones, e.g. "Europe/Paris".')
  const defaultHour = options.schedule?.defaultHour ?? 12
  if (!(Number.isInteger(defaultHour) && defaultHour >= 0 && defaultHour <= 23)) fail('`schedule.defaultHour` must be 0 to 23.')
  const videosDefault = options.defaults?.videosDefault ?? 'picked'
  if (!['rules', 'picked'].includes(videosDefault)) fail('`defaults.videosDefault` must be "rules" or "picked".')
  const curationLevel = options.curation?.level ?? 'creator'
  if (!['creator', 'channel'].includes(curationLevel)) fail('`curation.level` must be "creator" or "channel".')
  const urgentAt = options.curation?.urgentAt ?? 25
  if (!(Number.isInteger(urgentAt) && urgentAt > 0)) fail('`curation.urgentAt` must be a whole number above 0.')
  const goneMode = options.goneVideos?.mode ?? 'keep'
  if (!['keep', 'clear'].includes(goneMode)) fail('`goneVideos.mode` must be "keep" or "clear".')
  const clearAfterDays = options.goneVideos?.clearAfterDays ?? 30
  if (!(Number.isInteger(clearAfterDays) && clearAfterDays >= 0)) fail('`goneVideos.clearAfterDays` must be a whole number, 0 or more.')
  const kinds = options.kinds ?? DEFAULT_KINDS
  if (!Array.isArray(kinds) || !kinds.length || kinds.some((k) => !k || typeof k.value !== 'string' || !k.value || typeof k.label !== 'string')) fail('`kinds` must be a list of { label, value }.')
  const values = new Set(kinds.map((k) => k.value))
  const shownKinds = options.shownKinds ?? (options.kinds ? [] : DEFAULT_SHOWN_KINDS)
  const topicKinds = options.topicKinds ?? shownKinds
  for (const [name, list] of [['shownKinds', shownKinds], ['topicKinds', topicKinds]] as const)
    if (!Array.isArray(list) || list.some((k) => !values.has(k))) fail(`\`${name}\` must list values from \`kinds\`.`)
  if (options.topics !== undefined) {
    const t = options.topics
    if (!t || typeof t.relationTo !== 'string' || !t.relationTo || !isFn(t.resolve)) fail('`topics` needs `relationTo` and `resolve(name, req)`.')
  }
  for (const k of ['classify', 'revalidate', 'notify'] as const) if (options[k] !== undefined && !isFn(options[k])) fail(`\`${k}\` must be a function, or left out.`)
  const descriptionChars = options.classifyDescriptionChars ?? 700
  if (!(Number.isInteger(descriptionChars) && descriptionChars >= 0)) fail('`classifyDescriptionChars` must be a whole number, 0 or more.')
  const adminReviewPath = options.admin === false ? '' : (options.admin?.reviewPath ?? '/watchlist-review')
  if (options.admin !== false && !/^\/[\w-]+(\/[\w-]+)*$/.test(adminReviewPath)) fail('`admin.reviewPath` must be a path under the admin route, such as "/watch-review".')
  if (yt.fetch !== undefined && !isFn(yt.fetch)) fail('`youtube.fetch` must be a function, or left out.')
  if (options.overrides !== undefined) {
    for (const [k, fn] of Object.entries(options.overrides)) {
      if (!['creators', 'videos', 'usage'].includes(k)) fail(`\`overrides\` names "${k}"; it takes creators, videos and usage.`)
      if (!isFn(fn)) fail(`\`overrides.${k}\` must be a function (collection) => collection.`)
    }
  }
  const collections = { creators: 'creators', videos: 'videos', usage: 'watchlist-usage', ...(options.collections ?? {}) }
  const existing = new Set((config.collections ?? []).map((c) => c.slug))
  for (const slug of Object.values(collections)) if (existing.has(slug)) fail(`the config already has a "${slug}" collection. Remove it: the plugin adds it.`)
  if (options.topics && !existing.has(options.topics.relationTo)) fail(`\`topics.relationTo\` names "${options.topics.relationTo}", which isn’t a collection here.`)
  return {
    ...options,
    collections,
    kinds,
    shownKinds,
    topicKinds,
    curationLevel,
    urgentAt,
    goneMode,
    clearAfterDays,
    dailyUnitCap: cap,
    siteDailyUnitCap: siteCap,
    syncNowCooldownMs: cooldown * 60_000,
    quotaTimeZone,
    rss: yt.rss !== false,
    timeZone,
    defaultHour,
    videosDefault,
    descriptionChars,
    adminReviewPath,
  }
}

/**
 * Watchlist for Payload. Adds `creators`, `videos` and `watchlist-usage`, with the site's own fields and changes
 * brought in through `overrides`, and keeps the options at `config.custom.watchlist` for the sync.
 */
export const watchlist =
  (options: WatchlistOptions): Plugin =>
  (config: Config): Config => {
    const o = checkOptions(options, config)
    const builders = { creators: creatorsCollection, videos: videosCollection, usage: usageCollection } as const
    const collections = (Object.keys(builders) as (keyof typeof builders)[]).map((key) => {
      const base = builders[key](o)
      const override = o.overrides?.[key]
      if (!override) return base
      // A second build for the override to change as it likes; the plugin's rules are put back from `base`.
      const copy = builders[key](o)
      return protect(base, override(copy), functionsOf(copy))
    })
    const out: Config = { ...config, collections: [...(config.collections ?? []), ...collections], custom: { ...config.custom, watchlist: o } }
    if (options.admin === false) return out
    // The review view and its nav link. Both check the person themselves; a signed-out or unroled visit shows a refusal.
    const components = config.admin?.components
    return {
      ...out,
      admin: {
        ...config.admin,
        components: {
          ...components,
          afterNavLinks: [...(components?.afterNavLinks ?? []), `${PACKAGE}/rsc#ReviewNavLink`],
          views: { ...components?.views, watchlistReview: { Component: `${PACKAGE}/rsc#ReviewView`, path: o.adminReviewPath as `/${string}`, exact: true } },
        },
      },
    }
  }
