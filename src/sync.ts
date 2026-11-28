import { createLocalReq, type Payload, type PayloadRequest } from 'payload'

import { exactlyTrue, idOf } from './access.js'
import { ownContext, syncContext, topicNames } from './collections.js'
import { ledger as makeLedger, type Ledger } from './ledger.js'
import { FeedError, readFeed, type FeedEntry } from './rss.js'
import { channelIdOf, lines, playlistIdOf, ruleHide, ruleKeyOf, youtubeImage, type ChannelRules } from './rules.js'
import { fullDue, isDue, recheckDue, SYNC_LOCK_MS } from './schedule.js'
import type { Classified, ResolvedOptions, SiteId, PlaylistsNotice } from './types.js'
import { COST, dataApi, scrub, YouTubeError, type DataApi, type YtVideo } from './youtube.js'

/**
 * The sync: per creator, per channel. The channel's feed first; the Data API only when the feed shows something new,
 * the rules changed, or a re-check, full read or back-catalog read is due. Every API call reserves its units in the
 * ledger first. Without a key, new feed videos are cataloged for review and never shown by the rules.
 */

export type SyncReport = {
  creator: string
  /** The creator's site, or null without scope. */
  site: SiteId | null
  /** Why nothing ran: outside calls off, the creator asked not to be featured, another run holds the lock. */
  skipped?: 'disabled' | 'do-not-feature' | 'busy' | 'not-found'
  added: number
  updated: number
  passed: number
  review: number
  unavailable: number
  returned: number
  cleared: number
  units: number
  /** A stop for the day: the cap, this site's share of it, or YouTube's quota. */
  stopped?: 'cap' | 'site-cap' | 'quota'
  note: string
}

export type SyncOptions = { now?: Date; full?: boolean; recheck?: boolean; budget?: number; req?: PayloadRequest }

class Stop extends Error {
  constructor(readonly why: 'cap' | 'site-cap' | 'quota') {
    super(why)
  }
}

export function optionsOf(payload: Payload): ResolvedOptions {
  const o = (payload.config.custom as { playlists?: ResolvedOptions } | undefined)?.playlists
  if (!o) throw new Error('Playlists isn’t installed in this Payload config: add playlists() to its plugins.')
  return o
}

type Channel = {
  id?: string
  handle: string
  title?: string | null
  channelId?: string | null
  uploads?: string | null
  playlists?: { id?: string; playlist: string; rule: string; title?: string | null; showName?: string | null }[] | null
  excludeKeywords?: string | null
  minMinutes?: number | null
  backfillToken?: string | null
  backfillDone?: boolean | null
  rssSeen?: string | null
  [k: string]: unknown
}
type Creator = { id: string; name: string; bio?: string | null; avatar?: string | null; channels?: Channel[] | null; doNotFeature?: boolean | null; syncingSince?: string | null; [k: string]: unknown }
type Stored = { id: string; youtubeId: string; locked?: boolean | null; kind?: string | null; hiddenReason?: string | null; playlists?: string[] | null; ruleKey?: string | null; source?: string | null; unavailable?: boolean | null; unavailableSince?: string | null; title?: string; description?: string | null; thumbnail?: string | null; embeddable?: boolean | null; madeForKids?: boolean | null }

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
export const RETRY_WAITS_MS = [2000, 8000]

/** The plugin's context for one run: the gates, the key, the ledger. */
export async function contextFor(payload: Payload, o: ResolvedOptions, req: PayloadRequest, now: () => Date) {
  const enabled = await exactlyTrue(() => o.enabled(req))
  let key: string | null = null
  if (enabled && typeof o.youtube?.apiKey === 'function') {
    try {
      const k = await o.youtube.apiKey(req)
      key = typeof k === 'string' && k.trim() ? k.trim() : null
    } catch {
      key = null
    }
  }
  const fetcher = o.youtube?.fetch ?? globalThis.fetch
  return { enabled, key, fetcher, ledger: makeLedger(payload, o, now), sleep: o.youtube?.sleep ?? sleepReal }
}

async function tell(o: ResolvedOptions, req: PayloadRequest, enabled: boolean, notice: PlaylistsNotice) {
  if (!enabled || !o.notify) return
  try {
    await o.notify(notice, { req })
  } catch {
    // A notice that can't be sent doesn't stop the sync.
  }
}

/** The run lock: one atomic update, so a second run of the same creator is refused while the first holds it. */
async function lock(payload: Payload, o: ResolvedOptions, id: string, now: Date): Promise<boolean> {
  const model = (payload.db as unknown as { collections: Record<string, { updateOne: (f: object, u: object) => Promise<{ modifiedCount: number }> }> }).collections[o.collections.creators]
  if (!model?.updateOne) throw new Error('Playlists: the run lock needs MongoDB.')
  const stale = new Date(now.getTime() - SYNC_LOCK_MS)
  const r = await model.updateOne({ _id: id, $or: [{ syncingSince: null }, { syncingSince: { $exists: false } }, { syncingSince: { $lt: stale } }] }, { $set: { syncingSince: now } })
  return r.modifiedCount === 1
}

/**
 * Sync one creator. `full` reads the whole uploads list (monthly); `recheck` re-reads every stored video (weekly), marking
 * gone ones and bringing YouTube's titles up to date. `budget` caps how many videos are examined this run.
 */
export async function syncCreator(payload: Payload, creatorId: string, opts: SyncOptions = {}): Promise<SyncReport> {
  const o = optionsOf(payload)
  const nowDate = opts.now ?? new Date()
  const now = () => nowDate
  const req = opts.req ?? (await createLocalReq({}, payload))
  const env = await contextFor(payload, o, req, now)
  const report: SyncReport = { creator: creatorId, site: null, added: 0, updated: 0, passed: 0, review: 0, unavailable: 0, returned: 0, cleared: 0, units: 0, note: '' }
  const creator = (await payload.findByID({ collection: o.collections.creators, id: creatorId, depth: 0, overrideAccess: true, disableErrors: true })) as unknown as Creator | null
  if (!creator) return { ...report, skipped: 'not-found', note: 'No such creator.' }
  if (creator.doNotFeature === true) return { ...report, skipped: 'do-not-feature', note: 'Asked not to be featured: not synced.' }
  if (!env.enabled) return { ...report, skipped: 'disabled', note: 'Outside calls are off: not synced.' }
  if (!(await lock(payload, o, creatorId, nowDate))) return { ...report, skipped: 'busy', note: 'Another run of this creator is going.' }

  const site: SiteId | null = o.scope.field ? (idOf(creator[o.scope.field]) as SiteId | null) : null
  report.site = site
  const t = topicNames(o)
  const channels: Channel[] = structuredClone(creator.channels ?? [])
  const notes: string[] = []
  let budget = opts.budget ?? 150
  let avatar = creator.avatar ?? null
  let bio = creator.bio ?? null
  const usage = await env.ledger.usage()
  const api: DataApi | null = env.key && !usage.quotaStopped ? dataApi(env.key, env.fetcher) : null
  if (env.key && usage.quotaStopped) {
    report.stopped = 'quota'
    notes.push('YouTube’s daily quota is used up; the API waits for tomorrow.')
  }
  if (!env.key) notes.push('No API key: new videos from the feed wait for review, unchecked by the rules.')

  /** One API call: units reserved first, a rate limit or YouTube error tried twice more after 2 and 8 seconds. */
  async function call<T>(units: number, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const reserved = await env.ledger.reserve(units, site)
      if (reserved !== 'ok') throw new Stop(reserved)
      report.units += units
      try {
        return await fn()
      } catch (error) {
        if (error instanceof YouTubeError && error.failure === 'quota') {
          await env.ledger.stopForQuota()
          throw new Stop('quota')
        }
        if (error instanceof YouTubeError && error.failure === 'retry' && attempt < RETRY_WAITS_MS.length) {
          await env.sleep(RETRY_WAITS_MS[attempt]!)
          continue
        }
        throw error
      }
    }
  }

  const write = async (existing: Stored | undefined, data: Record<string, unknown>) => {
    const scoped = o.scope.field ? { ...data, [o.scope.field]: creator[o.scope.field] !== undefined ? idOf(creator[o.scope.field]) : undefined } : data
    if (existing) {
      await payload.update({ collection: o.collections.videos, id: existing.id, data: scoped as never, overrideAccess: true, depth: 0, context: syncContext, req: ownContext(req) })
      report.updated++
    } else {
      await payload.create({ collection: o.collections.videos, data: scoped as never, overrideAccess: true, depth: 0, context: syncContext, req: ownContext(req) })
      report.added++
    }
  }

  const storedOf = async () =>
    new Map(
      (
        (
          await payload.find({
            collection: o.collections.videos,
            where: { creator: { equals: creatorId } },
            depth: 0,
            pagination: false,
            overrideAccess: true,
            select: { youtubeId: true, locked: true, kind: true, hiddenReason: true, playlists: true, ruleKey: true, source: true, unavailable: true, unavailableSince: true, title: true, description: true, thumbnail: true, embeddable: true, madeForKids: true } as never,
          })
        ).docs as unknown as Stored[]
      ).map((d) => [String(d.youtubeId), d]),
    )

  try {
    for (const ch of channels) {
      if (budget <= 0) break
      ch.channelId ||= channelIdOf(ch.handle)
      // 1. The channel: its ID (free from a pasted link), and its uploads list (one API call, once).
      if (api && (!ch.channelId || !ch.uploads)) {
        const found = await call(COST.channel, () => api.channel(ch.channelId || ch.handle))
        if (!found) {
          notes.push(`No YouTube channel found for ${ch.handle}.`)
          await tell(o, req, env.enabled, { kind: 'playlists.sync-problem', site, creator: creatorId, problem: 'channel-not-found', note: ch.handle })
          continue
        }
        Object.assign(ch, { channelId: found.id, title: found.title, uploads: found.uploads })
        avatar ??= youtubeImage(found.avatar)
        if (!bio) bio = found.description.split('\n')[0]?.slice(0, 300) || null
      }
      if (!ch.channelId) {
        notes.push(`${ch.handle}: paste the channel link (or add an API key) so its feed can be read.`)
        continue
      }
      // 2. The feed: is anything new?
      let feed: FeedEntry[] | null = null
      if (o.rss) {
        try {
          feed = await readFeed(ch.channelId, env.fetcher)
        } catch (error) {
          notes.push(`${ch.handle}: ${error instanceof FeedError ? error.message : 'The feed could not be read.'}${api ? ' Used the API instead.' : ''}`)
        }
      }
      const playlistRules = (ch.playlists ?? []).filter((p) => p.rule !== 'show')
      const keywords = lines(ch.excludeKeywords)
      const titles = o.topics ? lines(ch[t.titles] as string | null) : []
      const ruleKey = ruleKeyOf([ch.minMinutes ?? 0, o.topics ? (ch[t.mode] ?? 'review') : null, playlistRules.map((p) => [playlistIdOf(p.playlist), p.rule]), keywords, titles, o.shownKinds])
      const known = await storedOf()
      const stale = [...known.values()].some((d) => !d.locked && !d.unavailable && d.ruleKey !== ruleKey)
      const feedNew = feed ? feed.filter((e) => !known.has(e.id)) : null
      const extra = Boolean(opts.full || opts.recheck || stale || (api && !ch.backfillDone))
      if (feed && !feedNew!.length && !extra) {
        ch.rssSeen = feed[0]?.id ?? ch.rssSeen ?? null
        continue // nothing new: no units spent
      }
      if (!api) {
        // Feed only: catalog new videos for review. They never show by the rules.
        for (const e of (feedNew ?? []).slice(0, budget)) {
          await write(undefined, {
            creator: creatorId,
            channelId: ch.channelId,
            youtubeId: e.id,
            title: e.title || e.id,
            description: e.description,
            publishedAt: e.published,
            thumbnail: e.thumbnail,
            source: 'rss',
            passedRules: false,
            hiddenReason: 'Waiting for review: from the feed only, not checked by the rules',
          })
          report.review++
          budget--
        }
        if (feed) ch.rssSeen = feed[0]?.id ?? ch.rssSeen ?? null
        continue
      }
      // 3. Rule playlists: which videos are in each.
      const rules: ChannelRules = { include: new Set(), exclude: new Set(), topic: new Set(), keywords, minMinutes: ch.minMinutes }
      const inPlaylist = new Map<string, string[]>()
      for (const p of playlistRules) {
        const pid = playlistIdOf(p.playlist)
        p.playlist = pid
        if (!p.title) p.title = await call(COST.playlistTitle, () => api.playlistTitle(pid))
        let token: string | undefined
        for (let page = 0; page < 20; page++) {
          const r = await call(COST.playlistPage, () => api.playlistPage(pid, token))
          for (const v of r.ids) {
            if (p.rule === 'include') rules.include.add(v)
            else if (p.rule === 'exclude') rules.exclude.add(v)
            else if (o.topics && p.rule === t.rule) rules.topic.add(v)
            inPlaylist.set(v, [...new Set([...(inPlaylist.get(v) ?? []), pid])])
          }
          if (!r.next) break
          token = r.next
        }
      }
      // 4. Which videos to look at: new ones, then ones to judge again, then the back catalog, then retries.
      const wanted: string[] = []
      if (feedNew && !opts.full) wanted.push(...feedNew.map((e) => e.id))
      else if (ch.uploads) {
        let token: string | undefined
        for (let page = 0; page < (opts.full ? 100 : 10) && budget > wanted.length; page++) {
          const r = await call(COST.playlistPage, () => api.playlistPage(ch.uploads!, token))
          const fresh = r.ids.filter((id) => !known.has(id))
          wanted.push(...fresh)
          if ((!opts.full && fresh.length < r.ids.length) || !r.next) break
          token = r.next
        }
      }
      const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))
      for (const [id, d] of known) if (!d.locked && !d.unavailable && (d.ruleKey !== ruleKey || !sameSet(d.playlists ?? [], inPlaylist.get(id) ?? []))) wanted.push(id)
      if (!ch.backfillDone && ch.uploads) {
        let next = ch.backfillToken ?? undefined
        while (wanted.length < budget) {
          const r = await call(COST.playlistPage, () => api.playlistPage(ch.uploads!, next))
          wanted.push(...r.ids.filter((id) => !known.has(id)))
          if (!r.next) {
            ch.backfillDone = true
            ch.backfillToken = null
            break
          }
          next = r.next
          ch.backfillToken = next
        }
      }
      for (const [id, d] of known) if (!d.locked && !d.unavailable && (d.source === 'rss' || (!d.kind && !d.hiddenReason?.startsWith('Rule')))) wanted.push(id)
      const ids = [...new Set(wanted)].slice(0, budget)
      budget -= ids.length
      // 5. Details, rules, classification.
      const details: YtVideo[] = []
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50)
        details.push(...(await call(COST.videos, () => api.videos(batch))))
      }
      const toClassify = details.filter((v) => !ruleHide(v, rules) && !known.get(v.id)?.locked)
      let classes = new Map<string, Classified>()
      if (toClassify.length && o.classify) {
        try {
          const got = await o.classify(
            toClassify.map((v) => ({ key: v.id, title: v.title, description: v.description.slice(0, o.descriptionChars), channel: ch.title ?? ch.handle })),
            { req },
          )
          if (got instanceof Map) classes = got
        } catch (error) {
          notes.push(`Typing videos failed; they wait unclassified (${scrub((error as Error | null)?.message ?? 'no reason', env.key ?? '').slice(0, 120)}).`)
        }
      }
      for (const v of details) {
        const existing = known.get(v.id)
        if (existing?.locked) continue
        const hidden = ruleHide(v, rules)
        const c = classes.get(v.id)
        const valid = c && typeof c.kind === 'string' && o.kinds.some((k) => k.value === c.kind)
        const relevant = Boolean(valid) && c!.relevant !== false
        const passedRules = !hidden && relevant && o.shownKinds.includes(c!.kind)
        const data: Record<string, unknown> = {
          creator: creatorId,
          channelId: ch.channelId,
          youtubeId: v.id,
          title: v.title.slice(0, 300) || v.id,
          description: v.description.slice(0, 2000),
          publishedAt: v.publishedAt,
          duration: v.duration,
          thumbnail: youtubeImage(v.thumbnail),
          playlists: inPlaylist.get(v.id) ?? [],
          ruleKey,
          kind: valid ? c!.kind : null,
          embeddable: v.embeddable,
          madeForKids: v.madeForKids,
          source: 'api',
          passedRules,
          hiddenReason: hidden ?? (valid ? (passedRules ? null : !relevant ? 'Not about the site’s subject' : `Type: ${c!.kind}`) : c ? 'The classifier’s answer couldn’t be read' : 'Not classified yet'),
        }
        if (o.topics) Object.assign(data, await topicState(o, req, ch, c, passedRules, rules.topic.has(v.id) || titles.some((x) => v.title.toLowerCase().includes(x))))
        await write(existing, data)
        if (passedRules) report.passed++
        else if (!hidden) report.review++
      }
      if (feed) ch.rssSeen = feed[0]?.id ?? ch.rssSeen ?? null
    }
    if (api && (opts.recheck || opts.full)) await recheck(await storedOf(), (b) => call(COST.videos, () => api.videos(b)), write, report)
  } catch (error) {
    if (error instanceof Stop) {
      report.stopped = error.why
      notes.push(error.why === 'cap' ? `Today’s cap of ${o.dailyUnitCap} units is reached; the next run continues.` : error.why === 'site-cap' ? `This site’s share of today’s units (${o.siteDailyUnitCap}) is used; the next run continues tomorrow.` : 'YouTube’s daily quota is used up; the next run continues.')
      await tell(o, req, env.enabled, { kind: 'playlists.sync-problem', site, creator: creatorId, problem: error.why, note: notes.at(-1)! })
    } else {
      const message = scrub((error as Error | null)?.message ?? 'unknown error', env.key ?? '')
      notes.push(`Sync stopped: ${message}`)
      await tell(o, req, env.enabled, { kind: 'playlists.sync-problem', site, creator: creatorId, problem: 'error', note: message })
    }
  }
  if (o.goneMode === 'clear') report.cleared = await clearGone(payload, o, creatorId, nowDate, req)
  const done = channels.every((c) => c.backfillDone)
  notes.unshift(
    `${report.added} new, ${report.updated} updated: ${report.passed} passed the rules, ${report.review} wait for review.${report.unavailable ? ` ${report.unavailable} gone from YouTube.` : ''}${report.returned ? ` ${report.returned} back on YouTube.` : ''}${report.units ? ` ${report.units} API units.` : ''}${!api || done ? '' : ' More history next run.'}`,
  )
  report.note = notes.join(' ')
  const finished = !report.stopped
  await payload.update({
    collection: o.collections.creators,
    id: creatorId,
    data: {
      channels,
      avatar,
      bio,
      lastSyncedAt: nowDate.toISOString(),
      syncNote: report.note,
      syncingSince: null,
      ...(finished && api && (opts.recheck || opts.full) ? { lastRecheckAt: nowDate.toISOString() } : {}),
      ...(finished && api && opts.full ? { lastFullSyncAt: nowDate.toISOString() } : {}),
    } as never,
    overrideAccess: true,
    depth: 0,
    context: syncContext,
    req: ownContext(req),
  })
  return report
}

/** Topic pages: automatic only for topic playlists, title phrases or single-topic channels, and only for `topicKinds`. */
async function topicState(o: ResolvedOptions, req: PayloadRequest, ch: Channel, c: Classified | undefined, passed: boolean, inTopicPlaylist: boolean) {
  const t = topicNames(o)
  const names = Array.isArray(c?.topics) ? c!.topics.filter((n) => typeof n === 'string' && n).slice(0, 20) : []
  const ids: (string | number)[] = []
  for (const n of names) {
    try {
      const id = await o.topics!.resolve(n, req)
      if ((typeof id === 'string' && id) || typeof id === 'number') ids.push(id)
    } catch {
      // An unresolved name is simply not linked.
    }
  }
  const mode = ch[t.mode] ?? 'review'
  const proposed = !passed
    ? 'none'
    : inTopicPlaylist
      ? ids.length === 1
        ? 'auto'
        : ids.length > 1
          ? 'review'
          : names.length
            ? 'none'
            : 'review'
      : mode === 'never' || c?.singleTopic !== true || ids.length !== 1
        ? 'none'
        : mode === 'single-species'
          ? 'auto'
          : 'review'
  const state = proposed === 'auto' && !o.topicKinds.includes(c!.kind) ? 'review' : proposed
  return { [t.field]: ids, [t.names]: names, [t.state]: state }
}

/**
 * Re-read stored videos, 50 at a time. Gone ones are marked, never deleted here, and a curator's choices stay; ones
 * that came back are judged again at the next sync. YouTube's own title, description and thumbnail follow YouTube, for
 * locked videos too.
 */
async function recheck(stored: Map<string, Stored>, videos: (ids: string[]) => Promise<YtVideo[]>, write: (e: Stored, d: Record<string, unknown>) => Promise<void>, report: SyncReport) {
  const all = [...stored.values()]
  for (let i = 0; i < all.length; i += 50) {
    const batch = all.slice(i, i + 50)
    const live = new Map((await videos(batch.map((v) => v.youtubeId))).map((v) => [v.id, v]))
    for (const v of batch) {
      const y = live.get(v.youtubeId)
      const data: Record<string, unknown> = {}
      if (!y) {
        if (!v.unavailable) {
          data.unavailable = true
          report.unavailable++
        }
      } else {
        if (v.unavailable) {
          data.unavailable = false
          if (!v.locked) data.ruleKey = null
          report.returned++
        }
        const title = y.title.slice(0, 300) || y.id
        const description = y.description.slice(0, 2000)
        if (title !== v.title) data.title = title
        if (description !== (v.description ?? '')) data.description = description
        const thumbnail = youtubeImage(y.thumbnail)
        if (thumbnail && thumbnail !== v.thumbnail) data.thumbnail = thumbnail
        if (y.embeddable !== v.embeddable) data.embeddable = y.embeddable
        if (y.madeForKids !== (v.madeForKids ?? null)) data.madeForKids = y.madeForKids
      }
      if (Object.keys(data).length) {
        await write(v, data)
        report.updated--
      }
    }
  }
}

export const GONE_TITLE = 'Gone from YouTube'

/**
 * `goneVideos.mode: 'clear'`: a video gone longer than `clearAfterDays` keeps only the site's own notes (its YouTube ID,
 * the curator's choice, its topic links); YouTube's title, description and thumbnail are cleared. A video that comes back
 * gets them again at the next re-check.
 */
async function clearGone(payload: Payload, o: ResolvedOptions, creatorId: string, now: Date, req: PayloadRequest): Promise<number> {
  const before = new Date(now.getTime() - o.clearAfterDays * 86_400_000).toISOString()
  const { docs } = await payload.find({
    collection: o.collections.videos,
    where: { and: [{ creator: { equals: creatorId } }, { unavailable: { equals: true } }, { unavailableSince: { less_than_equal: before } }, { title: { not_equals: GONE_TITLE } }] },
    depth: 0,
    pagination: false,
    overrideAccess: true,
    select: { id: true } as never,
    req,
  })
  for (const d of docs as unknown as { id: string }[]) await payload.update({ collection: o.collections.videos, id: d.id, data: { title: GONE_TITLE, description: null, thumbnail: null, duration: null, playlists: [] } as never, overrideAccess: true, depth: 0, context: syncContext, req: ownContext(req) })
  return docs.length
}

export type CronReport = { due: number; synced: number; skipped: number; busy: number; stopped: 'cap' | 'quota' | null; reports: SyncReport[] }

/**
 * The site's cron calls this (hourly): the creators whose scheduled time has passed since their last sync, oldest first,
 * within a time budget (the rest next hour). Each is re-checked weekly and read in full monthly in the same run. The site
 * checks its own cron secret first; this function doesn't read one.
 */
export async function syncDue(payload: Payload, opts: { now?: Date; budgetMs?: number; req?: PayloadRequest } = {}): Promise<CronReport> {
  const o = optionsOf(payload)
  const now = opts.now ?? new Date()
  const start = Date.now()
  const budgetMs = opts.budgetMs ?? 240_000
  const { docs } = await payload.find({
    collection: o.collections.creators,
    where: { doNotFeature: { not_equals: true } },
    depth: 0,
    pagination: false,
    overrideAccess: true,
    sort: 'lastSyncedAt',
    select: { lastSyncedAt: true, syncDays: true, syncHour: true, lastRecheckAt: true, lastFullSyncAt: true } as never,
  })
  const out: CronReport = { due: 0, synced: 0, skipped: 0, busy: 0, stopped: null, reports: [] }
  for (const c of docs as unknown as { id: string; lastSyncedAt?: string | null; syncDays?: string[] | null; syncHour?: number | null; lastRecheckAt?: string | null; lastFullSyncAt?: string | null }[]) {
    if (!isDue(now, c, o.timeZone, o.defaultHour)) continue
    out.due++
    if (Date.now() - start > budgetMs || out.stopped) {
      out.skipped++
      continue
    }
    const full = fullDue(now, c.lastFullSyncAt)
    const r = await syncCreator(payload, String(c.id), { now, full, recheck: full || recheckDue(now, c.lastRecheckAt), req: opts.req })
    out.reports.push(r)
    if (r.skipped === 'busy') out.busy++
    else if (r.skipped) out.skipped++
    else out.synced++
    // One site's share being used stops that site only; the cap and the quota stop everyone.
    if (r.stopped === 'cap' || r.stopped === 'quota') out.stopped = r.stopped
  }
  // The site's cache, once per site that changed.
  if (o.revalidate)
    for (const site of new Set(out.reports.filter((r) => !r.skipped && (r.added || r.updated)).map((r) => r.site)))
      for (const tag of ['videos', 'creators'] as const)
        try {
          o.revalidate({ site, tag })
        } catch {
          // the site's cache
        }
  // Past the threshold, the curators hear at once (at most once a day per site).
  const grew = [...new Set(out.reports.filter((r) => !r.skipped && r.added > 0).map((r) => r.site))]
  if (grew.length) {
    const { sendReviewDigest } = await import('./curation.js')
    await sendReviewDigest(payload, { mode: 'urgent', sites: grew, now, req: opts.req }).catch(() => undefined)
  }
  return out
}

export type { Ledger }
