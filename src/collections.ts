import { randomUUID } from 'node:crypto'
import { Forbidden, isolateObjectProperty, slugField, type CollectionAfterChangeHook, type CollectionBeforeChangeHook, type CollectionBeforeValidateHook, type CollectionConfig, type Field, type FieldHook, type CollectionBeforeOperationHook, type CollectionAfterReadHook, type PayloadRequest, type Where } from 'payload'
import { generateKeyBetween } from 'payload/shared'

import { createAccess, curateAccess, editAccess, editSites, holds, idOf, isAdmin, nobody, queryGuard, readCreators, readVideos, sitesFor, staffField, type InternalPaths } from './access.js'
import { AlreadyDecided, CrossSite } from './errors.js'
import { siteKey } from './ledger.js'
import { noCopy } from './noCopy.js'
import { reviewEndpoint, syncNowEndpoint } from './endpoints.js'
import { shapeGuard, shapeGuardChange } from './shape.js'
import { DAYS } from './schedule.js'
import { channelIdOf, computeShown, isVideoId, youtubeImage } from './rules.js'
import type { ResolvedOptions } from './types.js'

/** Set on the plugin's own writes (the sync, the review claim), so hooks meant for people leave them alone. */
export const PACKAGE = '@extantape/payload-plugin-playlists'
export const SYNC_CONTEXT = 'playlistsSync'
export const isSync = (context: unknown) => Boolean(context && (context as Record<string, unknown>)[SYNC_CONTEXT] === true)
export const syncContext = { [SYNC_CONTEXT]: true, disableRevalidate: true }
/** The request to pass along with `syncContext`: a copy with its own context, for the plugin's own write. */
export const ownContext = (req: PayloadRequest): PayloadRequest => isolateObjectProperty(req, 'context')

/** The fields a curator may change on a video of their site; everything else needs an editor. */
export function curatorFields(o: ResolvedOptions): string[] {
  const t = o.topics
  return ['shown', 'choice', 'kind', 'locked', ...(t ? [t.field ?? 'species', t.stateField ?? 'speciesState'] : [])]
}

/**
 * Fields the public never reads, filters or sorts on: only an admin and the record's own site's curators and editors.
 * Everything else on a creator or a video is public (listed in the README). `videosDefault` is public since 2026-11-11
 * (the site's team): the site's visibility rules read it and filter on it.
 */
export const INTERNAL_CREATOR_FIELDS = ['doNotFeature', 'doNotFeatureNote', 'syncDays', 'syncHour', 'lastSyncedAt', 'lastRecheckAt', 'lastFullSyncAt', 'syncingSince', 'syncNote']
/** Inside `channels`: the rules and the sync's state. `handle`, `title`, `channelId` and `playlists` (the site's pages read the old "own filter" names there) are public. */
export const INTERNAL_CHANNEL_FIELDS = ['excludeKeywords', 'minMinutes', 'uploads', 'backfillToken', 'backfillDone', 'rssSeen', 'curation']
export const INTERNAL_VIDEO_FIELDS = ['hiddenReason', 'ruleKey', 'locked', 'source', 'channelId', 'curation', 'passedRules', 'unavailableSince', 'claim']
export const INTERNAL_USAGE_FIELDS = ['units', 'bySite', 'digests']

export function internalPaths(o: ResolvedOptions) {
  const t = topicNames(o)
  const creators = [...INTERNAL_CREATOR_FIELDS, ...[...INTERNAL_CHANNEL_FIELDS, ...(o.topics ? [t.mode, t.titles] : [])].map((f) => `channels.${f}`)]
  const videos = [...INTERNAL_VIDEO_FIELDS, ...(o.topics ? [t.names] : [])]
  return {
    creators: { own: creators } as InternalPaths,
    videos: { own: videos, related: { creator: creators } } as InternalPaths,
    usage: { own: INTERNAL_USAGE_FIELDS } as InternalPaths,
  }
}

type Walkable = Field & { name?: string; fields?: Field[]; access?: Record<string, unknown> }
/** Puts a read rule on each named field, looking inside rows and collapsibles; `nested` does the same inside an array. */
function guardFields(fields: Field[], names: string[], read: unknown, nested: Record<string, string[]> = {}): Field[] {
  return fields.map((f) => {
    const x = f as Walkable
    if (x.name && names.includes(x.name)) return { ...x, access: { ...(x.access ?? {}), read } } as Field
    if (x.name && nested[x.name] && x.fields) return { ...x, fields: guardFields(x.fields, nested[x.name]!, read) } as Field
    if (!x.name && x.fields) return { ...x, fields: guardFields(x.fields, names, read, nested) } as Field
    return f
  })
}

const httpOnly = (v: unknown) => {
  if (v === null || v === undefined || v === '') return true
  try {
    const u = new URL(String(v))
    return u.protocol === 'https:' || u.protocol === 'http:' ? true : 'Only an http or https link.'
  } catch {
    return 'Only an http or https link.'
  }
}

/** Field names, with the site's own names for the topic fields. */
export const topicNames = (o: ResolvedOptions) => ({
  field: o.topics?.field ?? 'species',
  state: o.topics?.stateField ?? 'speciesState',
  names: o.topics?.namesField ?? 'speciesNames',
  mode: o.topics?.modeField ?? 'speciesMode',
  titles: o.topics?.titlesField ?? 'speciesTitles',
  rule: o.topics?.playlistRule ?? 'topic',
})

const imageOnly: FieldHook = ({ value }) => (value == null || value === '' ? value : youtubeImage(String(value)))

// ---------------------------------------------------------------- shared hooks

const norm = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(norm)
  if (v instanceof Date) return v.toISOString()
  if (v && typeof v === 'object' && 'id' in (v as object)) return idOf(v)
  if (v === undefined || v === '') return null
  return v
}
const same = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b))
const SYSTEM_KEYS = new Set(['id', '_id', 'createdAt', 'updatedAt', '_order'])

/**
 * People only write to their own sites: a new record goes on a site the writer edits, and a record's site never
 * changes except by an admin. Writes without a person (the site's own Local API calls, the sync) aren't checked here;
 * access already covers people.
 */
function siteGuard(o: ResolvedOptions, role: 'edit' | 'curate'): CollectionBeforeChangeHook {
  return async ({ data, originalDoc, operation, req, context }) => {
    if (!req.user || isSync(context)) return data
    if (await isAdmin(o, req)) return data
    const field = o.scope.field
    const editSites = await sitesFor(o, req, 'edit')
    if (operation === 'create') {
      if (!holds(o, editSites, field ? data[field] : null)) throw new Forbidden(req.t)
      return data
    }
    if (field && field in data && !same(data[field], originalDoc?.[field])) throw new Forbidden(req.t)
    if (role === 'curate' && !holds(o, editSites, field ? originalDoc?.[field] : null)) {
      // A curator, not an editor of this site: only the review fields may change.
      const allowed = new Set(curatorFields(o))
      for (const [k, v] of Object.entries(data)) if (!allowed.has(k) && !SYSTEM_KEYS.has(k) && k !== field && !same(v, originalDoc?.[k])) throw new Forbidden(req.t)
    }
    return data
  }
}

/** On a creator, and on each of its channels: the sync's own state. */
const SYNC_CREATOR_FIELDS = ['lastSyncedAt', 'lastRecheckAt', 'lastFullSyncAt', 'syncingSince', 'syncNote']
const SYNC_CHANNEL_FIELDS = ['uploads', 'backfillToken', 'backfillDone', 'rssSeen']
/** On a video: what the sync and the review write, and what the plugin works out. The topic names are added with topics. */
const SYNC_VIDEO_FIELDS = ['claim', 'hiddenReason', 'ruleKey', 'passedRules', 'source', 'channelId', 'curation', 'embeddable', 'madeForKids', 'unavailable', 'unavailableSince']

/** Sets each field back to what's stored. With nothing stored, as on a new record, the sent value is dropped. */
function keepStored(data: Record<string, unknown>, stored: Record<string, unknown> | undefined, fields: string[]) {
  for (const f of fields) {
    if (stored && stored[f] !== undefined) data[f] = stored[f]
    else delete data[f]
  }
}

/**
 * Whether a person's change points a stored channel row at a different channel. The admin sends the stored channel ID
 * back with a new handle, so in that case the ID is worked out again: a channel link gives it, and the next sync looks
 * up anything else.
 */
function movedChannel(row: Record<string, unknown>, prev: Record<string, unknown>): boolean {
  if (row.handle !== prev.handle && row.channelId === prev.channelId) row.channelId = channelIdOf(row.handle as string) ?? null
  return (row.channelId ?? null) !== (prev.channelId ?? null)
}

/**
 * A person's write, an admin's included, never sets these. They're dropped without an error, because the admin sends a
 * whole record back when it's saved. Writes without a person and the plugin's own writes pass.
 */
const creatorSyncState: CollectionBeforeChangeHook = ({ data, originalDoc, req, context }) => {
  if (!req.user || isSync(context)) return data
  keepStored(data, originalDoc, SYNC_CREATOR_FIELDS)
  if (Array.isArray(data.channels)) {
    const rows = (originalDoc?.channels ?? []) as Record<string, unknown>[]
    for (const row of data.channels as Record<string, unknown>[]) {
      const prev = row.id ? rows.find((r) => r.id === row.id) : undefined
      // A row pointed at a different channel starts its sync state over.
      if (prev && movedChannel(row, prev)) for (const f of SYNC_CHANNEL_FIELDS) delete row[f]
      else keepStored(row, prev, SYNC_CHANNEL_FIELDS)
    }
  }
  return data
}

const videoSyncState =
  (o: ResolvedOptions): CollectionBeforeChangeHook =>
  ({ data, originalDoc, operation, req, context }) => {
    if (!req.user || isSync(context)) return data
    keepStored(data, originalDoc, [...SYNC_VIDEO_FIELDS, ...(o.topics ? [topicNames(o).names] : [])])
    // The field's default, which applies to every new video.
    if (operation === 'create') data.unavailable = false
    return data
  }

/** The site's cache, after a person's change (a sync refreshes once at the end). */
function refresh(o: ResolvedOptions, tag: 'creators' | 'videos'): CollectionAfterChangeHook {
  return ({ doc, req, context }) => {
    if (!o.revalidate || isSync(context) || (req.context as Record<string, unknown>)?.disableRevalidate) return doc
    try {
      o.revalidate({ site: o.scope.field ? (idOf(doc[o.scope.field]) ?? null) : null, tag })
    } catch {
      // The cache is the site's; a failure there doesn't undo the change.
    }
    return doc
  }
}

// ---------------------------------------------------------------- creators

/** A creator's mode for its videos: exactly `rules`, else `picked`. A missing or unknown value is `picked`. */
export const creatorMode = (c: { videosDefault?: unknown } | null | undefined): 'rules' | 'picked' => (c?.videosDefault === 'rules' ? 'rules' : 'picked')

/** A video's curation: the channel's own setting (channel level only), else the creator's. */
export function curationFor(o: ResolvedOptions, creator: { videosDefault?: unknown; channels?: { channelId?: string | null; curation?: string | null }[] | null } | null, channelId?: string | null): 'rules' | 'picked' {
  if (!creator) return 'picked'
  if (o.curationLevel === 'channel' && channelId) {
    const ch = (creator.channels ?? []).find((c) => c.channelId === channelId)
    if (ch?.curation === 'rules' || ch?.curation === 'picked') return ch.curation
  }
  return creatorMode(creator)
}

const placeAlphabetically =
  (o: ResolvedOptions): CollectionBeforeChangeHook =>
  async ({ data, operation, req }) => {
    if (operation !== 'create' || data._order || typeof data.name !== 'string' || !data.name) return data
    const field = o.scope.field
    const { docs } = await req.payload.find({
      collection: o.collections.creators,
      where: field ? { [field]: { equals: idOf(data[field]) } } : {},
      sort: '_order',
      depth: 0,
      pagination: false,
      overrideAccess: true,
      select: { name: true, _order: true } as never,
      req,
    })
    const ordered = docs as unknown as { name: string; _order?: string }[]
    const next = ordered.findIndex((d) => String(d.name).localeCompare(data.name, 'en', { sensitivity: 'base' }) > 0)
    const before = next === -1 ? (ordered.at(-1)?._order ?? null) : next > 0 ? (ordered[next - 1]!._order ?? null) : null
    const after = next === -1 ? null : (ordered[next]!._order ?? null)
    try {
      data._order = generateKeyBetween(before, after)
    } catch {
      // Neighbors out of order after manual moves: Payload appends it at the end instead.
    }
    return data
  }

/** A pasted channel link gives its channel ID for free, so no API call is needed to find it. */
const channelIdsFromLinks: CollectionBeforeChangeHook = ({ data }) => {
  for (const ch of (data.channels ?? []) as { handle?: string; channelId?: string | null }[]) if (!ch.channelId) ch.channelId = channelIdOf(ch.handle) ?? ch.channelId ?? null
  return data
}

export const slugOf = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)

/** A slug from the name when none is given, before validation (the admin's slug field does this in the browser). */
const slugFromName: CollectionBeforeValidateHook = ({ data, operation }) => {
  if (data && operation === 'create' && !data.slug && typeof data.name === 'string') data.slug = slugOf(data.name) || null
  return data
}

/** A creator's mode change re-judges its videos in the same transaction. */
const rejudgeVideos =
  (o: ResolvedOptions): CollectionAfterChangeHook =>
  async ({ doc, previousDoc, operation, req }) => {
    if (operation !== 'update') return doc
    const chans = (c: typeof doc) => JSON.stringify(((c?.channels ?? []) as { channelId?: string; curation?: string }[]).map((x) => [x.channelId ?? null, x.curation ?? null]))
    if (creatorMode(doc) === creatorMode(previousDoc) && (o.curationLevel !== 'channel' || chans(doc) === chans(previousDoc))) return doc
    const groups = new Map<string, string[]>()
    const field = o.scope.field
    const where: Where = field ? { and: [{ creator: { equals: doc.id } }, { [field]: { equals: idOf(doc[field]) } }] } : { creator: { equals: doc.id } }
    const { docs } = await req.payload.find({ collection: o.collections.videos, where, depth: 0, pagination: false, overrideAccess: true, select: { channelId: true, curation: true } as never, req })
    for (const v of docs as unknown as { id: string; channelId?: string | null; curation?: string | null }[]) {
      const want = curationFor(o, doc, v.channelId)
      if (v.curation !== want) groups.set(want, [...(groups.get(want) ?? []), String(v.id)])
    }
    for (const [curation, ids] of groups)
      await req.payload.update({ collection: o.collections.videos, where: { id: { in: ids } }, data: { curation } as never, overrideAccess: true, depth: 0, req: ownContext(req), context: syncContext })
    return doc
  }

function creatorsBase(o: ResolvedOptions): CollectionConfig {
  const t = topicNames(o)
  const group = o.labels?.group ?? 'Playlists'
  const ruleOptions = [
    { label: 'Include only', value: 'include' },
    { label: 'Exclude', value: 'exclude' },
    ...(o.topics ? [{ label: 'Topic pages (automatic)', value: t.rule }] : []),
    { label: 'Own filter only (old: moves to Podcasts and shows on the next sync)', value: 'show' },
  ]
  const channelFields: Field[] = [
    {
      type: 'row',
      fields: [
        { name: 'handle', type: 'text', required: true, admin: { width: '40%', description: 'A handle such as @example, or a channel link (which needs no API call to find).' } },
        { name: 'title', type: 'text', admin: { width: '40%', readOnly: true, description: 'From YouTube.' } },
        { name: 'channelId', type: 'text', admin: { width: '20%', readOnly: true } },
      ],
    },
    ...(o.topics
      ? ([
          {
            name: t.mode,
            label: 'Topic pages',
            type: 'select',
            defaultValue: 'review',
            options: [
              { label: 'Ask me (single-topic videos go to review)', value: 'review' },
              { label: 'Automatic when a video is about one topic', value: 'single-species' },
              { label: 'Never', value: 'never' },
            ],
          },
        ] as Field[])
      : []),
    ...(o.curationLevel === 'channel'
      ? ([
          {
            name: 'curation',
            label: 'Which videos (this channel)',
            type: 'select',
            defaultValue: 'inherit',
            options: [
              { label: 'As the creator', value: 'inherit' },
              { label: 'Every video the rules and type allow', value: 'rules' },
              { label: 'Only videos a curator picks', value: 'picked' },
            ],
          },
        ] as Field[])
      : []),
    {
      name: 'playlists',
      label: 'Playlist rules',
      type: 'array',
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'playlist', type: 'text', required: true, admin: { width: '45%' } },
            { name: 'rule', type: 'select', required: true, defaultValue: 'exclude', options: ruleOptions, admin: { width: '25%' } },
            { name: 'title', type: 'text', admin: { width: '30%', readOnly: true } },
          ],
        },
        { name: 'showName', label: 'Own filter (old)', type: 'text', maxLength: 60, admin: { description: 'Old: use Podcasts and shows instead.' } },
      ],
    },
    { name: 'excludeKeywords', label: 'Exclude videos mentioning', type: 'textarea', admin: { description: 'One word or phrase per line, matched in the title and description.' } },
    { name: 'minMinutes', label: 'Hide videos shorter than (minutes)', type: 'number', min: 0 },
    ...(o.topics ? ([{ name: t.titles, label: 'Topic pages automatic for titles containing', type: 'textarea' }] as Field[]) : []),
    { name: 'uploads', type: 'text', admin: { hidden: true } },
    { name: 'backfillToken', type: 'text', admin: { hidden: true } },
    { name: 'backfillDone', type: 'checkbox', admin: { hidden: true } },
    { name: 'rssSeen', type: 'text', admin: { hidden: true } },
  ]
  return {
    slug: o.collections.creators,
    labels: { singular: 'Creator', plural: 'Creators' },
    admin: { group, useAsTitle: 'name', defaultColumns: ['name', 'listed', 'videosDefault', 'lastSyncedAt'] },
    access: { read: readCreators(o), create: createAccess(o), update: editAccess(o), delete: editAccess(o) },
    orderable: true,
    defaultSort: '_order',
    fields: [
      { name: 'name', type: 'text', required: true },
      slugField({ useAsSlug: 'name' }),
      {
        type: 'row',
        fields: [
          { name: 'listed', label: o.labels?.listed ?? 'Listed', type: 'checkbox', defaultValue: true, admin: { width: '40%' } },
          { name: 'website', type: 'text', validate: httpOnly, admin: { width: '60%' } },
        ],
      },
      { name: 'bio', type: 'textarea' },
      { name: 'avatar', type: 'text', hooks: { beforeChange: [imageOnly] }, admin: { readOnly: true, description: 'From YouTube.' } },
      {
        name: 'videosDefault',
        label: 'Which videos',
        type: 'select',
        defaultValue: o.videosDefault,
        options: [
          { label: 'Every video the rules and type allow', value: 'rules' },
          { label: 'Only videos a curator picks (Always show)', value: 'picked' },
        ],
        admin: { description: 'With “Only videos a curator picks”, nothing of theirs shows until a curator sets it to Always show.' },
      },
      {
        name: 'doNotFeature',
        label: 'Asked not to be featured',
        type: 'checkbox',
        defaultValue: false,
        admin: { description: 'The creator asked not to be featured: the sync stops and nothing of theirs shows. Only a person can clear it.' },
      },
      { name: 'doNotFeatureNote', label: 'Why, and when they asked', type: 'textarea', admin: { condition: (_, s) => Boolean(s?.doNotFeature) } },
      {
        name: 'showsDisplay',
        label: 'This creator’s podcasts and shows',
        type: 'select',
        defaultValue: 'inherit',
        options: [
          { label: 'As the site setting', value: 'inherit' },
          { label: 'Keep under this creator', value: 'keep' },
          { label: 'Each in its own entry, with this creator’s badge', value: 'own' },
          { label: 'Hidden', value: 'hide' },
        ],
      },
      {
        name: 'shows',
        label: 'Podcasts and shows',
        type: 'array',
        admin: { initCollapsed: true },
        fields: [
          {
            type: 'row',
            fields: [
              { name: 'playlist', type: 'text', required: true, admin: { width: '40%' } },
              { name: 'name', type: 'text', maxLength: 60, admin: { width: '35%' } },
              { name: 'kind', type: 'select', defaultValue: 'podcast', options: [{ label: 'Podcast', value: 'podcast' }, { label: 'Show', value: 'show' }], admin: { width: '25%' } },
            ],
          },
          {
            type: 'row',
            fields: [
              {
                name: 'display',
                label: 'On the video pages',
                type: 'select',
                defaultValue: 'inherit',
                options: [
                  { label: 'As this creator’s setting', value: 'inherit' },
                  { label: 'Keep under the creator', value: 'keep' },
                  { label: 'Its own entry, with the creator’s badge', value: 'own' },
                  { label: 'Hidden', value: 'hide' },
                ],
                admin: { width: '50%' },
              },
              { name: 'logo', type: 'text', hooks: { beforeChange: [imageOnly] }, admin: { width: '35%', readOnly: true } },
              { name: 'detected', label: 'Found by the sync', type: 'checkbox', admin: { width: '15%', readOnly: true } },
            ],
          },
        ],
      },
      { name: 'channels', type: 'array', minRows: 1, fields: channelFields },
      {
        type: 'collapsible',
        label: 'When to check for new videos',
        admin: { position: 'sidebar', initCollapsed: true },
        fields: [
          { name: 'syncDays', label: 'Days', type: 'select', hasMany: true, options: DAYS.map((d) => ({ label: d, value: d })), admin: { description: 'Empty means every day.' } },
          { name: 'syncHour', label: `Hour (${o.timeZone}, 0–23)`, type: 'number', min: 0, max: 23, defaultValue: o.defaultHour },
        ],
      },
      { name: 'lastSyncedAt', type: 'date', admin: { position: 'sidebar', readOnly: true, date: { pickerAppearance: 'dayAndTime' } } },
      { name: 'lastRecheckAt', type: 'date', admin: { hidden: true } },
      { name: 'lastFullSyncAt', type: 'date', admin: { hidden: true } },
      { name: 'syncingSince', type: 'date', admin: { hidden: true } },
      { name: 'syncNote', type: 'textarea', admin: { position: 'sidebar', readOnly: true } },
      // The admin's Sync now button: a UI field, so it stores nothing.
      { name: 'syncNow', type: 'ui', admin: { position: 'sidebar', components: { Field: `${PACKAGE}/rsc#SyncNowField` } } },
    ],
    endpoints: [syncNowEndpoint],
    hooks: {
      beforeValidate: [slugFromName],
      beforeChange: [siteGuard(o, 'edit'), channelIdsFromLinks, creatorSyncState, placeAlphabetically(o)],
      afterChange: [rejudgeVideos(o), refresh(o, 'creators')],
    },
    indexes: o.scope.field ? [{ fields: [o.scope.field, 'slug'], unique: true }] : [],
    timestamps: true,
  }
}

// ---------------------------------------------------------------- videos

/** A person's edit locks the video against the sync; a person's choice and "Shown" agree. */
const personEdits: CollectionBeforeChangeHook = ({ data, originalDoc, req, context }) => {
  if (!req.user || isSync(context)) return data
  data.locked = true
  if (data.choice !== undefined && data.choice !== (originalDoc?.choice ?? null)) {
    if (data.choice === 'show') data.shown = true
    if (data.choice === 'hide') data.shown = false
  } else if (data.shown !== undefined && data.shown !== (originalDoc?.shown ?? false)) data.choice = data.shown ? 'show' : 'hide'
  return data
}

/** The video's curation follows its creator (and channel); a new video or a moved one is judged here, on every write. */
const curationFromCreator =
  (o: ResolvedOptions): CollectionBeforeChangeHook =>
  async ({ data, originalDoc, operation, req }) => {
    const creatorId = idOf(data.creator ?? originalDoc?.creator)
    const moved = operation === 'create' || ('creator' in data && !same(data.creator, originalDoc?.creator)) || ('channelId' in data && data.channelId !== originalDoc?.channelId)
    if (!moved) return data
    const creator = creatorId ? await req.payload.findByID({ collection: o.collections.creators, id: creatorId, depth: 0, overrideAccess: true, disableErrors: true, req }) : null
    // Payload fills a missing select with its default when reading, so the stored value is read too: a creator with
    // no stored "Which videos" counts as picked, as the public read rule (which queries the database) does.
    const stored = creator ? await storedMode(req, o, creatorId!) : undefined
    data.curation = curationFor(o, creator ? ({ ...creator, ...(stored === undefined ? {} : { videosDefault: stored }) } as never) : null, (data.channelId ?? originalDoc?.channelId) as string | null)
    return data
  }

/** The creator's stored "Which videos", straight from the database: null when none is stored, undefined when unknown. */
async function storedMode(req: { payload: { db: unknown } }, o: ResolvedOptions, id: string): Promise<unknown> {
  const model = (req.payload.db as { collections?: Record<string, { findById?: (id: string, p: object) => { lean: () => Promise<Record<string, unknown> | null> } }> }).collections?.[o.collections.creators]
  if (!model?.findById) return undefined
  try {
    const raw = await model.findById(id, { videosDefault: 1 }).lean()
    return raw ? (raw.videosDefault ?? null) : undefined
  } catch {
    return null
  }
}

/**
 * A video and its creator are on the same site, for every write, the sync's included. A video with no site, or whose
 * creator can't be found, is refused.
 */
const sameSiteCreator =
  (o: ResolvedOptions): CollectionBeforeChangeHook =>
  async ({ data, originalDoc, operation, req }) => {
    const field = o.scope.field
    if (!field) return data
    const creatorId = idOf(data.creator ?? originalDoc?.creator)
    const site = idOf(field in data ? data[field] : originalDoc?.[field])
    const changed = operation === 'create' || ('creator' in data && !same(data.creator, originalDoc?.creator)) || (field in data && !same(data[field], originalDoc?.[field]))
    if (!changed) return data
    const creator = creatorId ? ((await req.payload.findByID({ collection: o.collections.creators, id: creatorId, depth: 0, overrideAccess: true, disableErrors: true, req })) as Record<string, unknown> | null) : null
    if (!creator || site === null || idOf(creator[field]) !== site) throw new CrossSite()
    return data
  }

/** The MongoDB session of the request's transaction, if there is one. */
async function sessionOf(req: { transactionID?: unknown; payload: { db: unknown } }): Promise<unknown> {
  const id = req.transactionID instanceof Promise ? await req.transactionID : req.transactionID
  if (id === undefined || id === null) return undefined
  return (req.payload.db as { sessions?: Record<string, unknown> }).sessions?.[String(id)]
}

/**
 * A curator's choice holds: a curator who isn't the one who decided can't change it. A person's first decision on a
 * video takes the claim with one atomic update, so two curators at once can't both decide; the second gets a 409.
 * Admins and the site's editors can always change it. A person's write never sets the claim itself (`videoSyncState`).
 */
const claimGuard =
  (o: ResolvedOptions): CollectionBeforeChangeHook =>
  async ({ data, originalDoc, operation, req, context }) => {
    if (operation !== 'update' || !req.user || isSync(context)) return data
    const changing = 'choice' in data && (data.choice ?? null) !== (originalDoc?.choice ?? null)
    if (!changing) return data
    if (await isAdmin(o, req)) return data
    if (holds(o, await editSites(o, req), o.scope.field ? originalDoc?.[o.scope.field] : null)) return data
    const me = idOf(req.user)
    const ownerOf = (claim: unknown) => (typeof claim === 'string' && claim ? claim.split(':')[0]! : null)
    const owner = ownerOf(originalDoc?.claim)
    if (owner && owner !== me) throw new AlreadyDecided()
    if (!owner) {
      const model = (req.payload.db as unknown as { collections: Record<string, { updateOne?: (f: object, u: object, opts?: object) => Promise<{ modifiedCount: number }> }> }).collections[o.collections.videos]
      if (!model?.updateOne) throw new Error('Playlists: review claims need MongoDB.')
      const token = `${me}:${randomUUID()}`
      // In the write's own transaction, so the claim and the decision commit together. Two at once: one wins, and the
      // other's transaction meets a write conflict, which is the same answer.
      const session = await sessionOf(req)
      let won: { modifiedCount: number }
      try {
        won = await model.updateOne({ _id: originalDoc.id, $or: [{ claim: null }, { claim: { $exists: false } }] }, { $set: { claim: token } }, ...(session ? [{ session }] : []))
      } catch (error) {
        if ((error as { code?: number } | null)?.code === 112 || /WriteConflict/i.test(String((error as Error | null)?.message))) throw new AlreadyDecided()
        throw error
      }
      if (won.modifiedCount !== 1) throw new AlreadyDecided()
      data.claim = token
    }
    return data
  }

/** "Shown" is computed, on every write by anyone: it can't be set around the rules. Clearing the choice frees the claim. */
const enforceShown: CollectionBeforeChangeHook = ({ data, originalDoc }) => {
  const merged = { ...(originalDoc ?? {}), ...data }
  data.shown = computeShown(merged)
  if ('choice' in data && (data.choice === null || data.choice === undefined) && originalDoc?.choice) data.claim = null
  if (data.unavailable === true && !originalDoc?.unavailable && !data.unavailableSince) data.unavailableSince = new Date().toISOString()
  if (data.unavailable === false) data.unavailableSince = null
  return data
}

function videosBase(o: ResolvedOptions): CollectionConfig {
  const t = topicNames(o)
  const group = o.labels?.group ?? 'Playlists'
  const topicFields: Field[] = o.topics
    ? [
        {
          type: 'row',
          fields: [
            { name: t.field, type: 'relationship', relationTo: o.topics.relationTo, hasMany: true, index: true, ...(o.topics.filterOptions ? { filterOptions: o.topics.filterOptions as never } : {}), admin: { width: '60%' } },
            {
              name: t.state,
              label: 'Topic pages',
              type: 'select',
              defaultValue: 'none',
              index: true,
              options: [
                { label: 'Not about one topic', value: 'none' },
                { label: 'Needs review', value: 'review' },
                { label: 'On topic pages (automatic)', value: 'auto' },
                { label: 'On topic pages (approved)', value: 'approved' },
                { label: 'Not on topic pages', value: 'rejected' },
              ],
              admin: { width: '40%' },
            },
          ],
        },
        { name: t.names, type: 'text', hasMany: true, admin: { readOnly: true } },
      ]
    : []
  return {
    slug: o.collections.videos,
    labels: { singular: 'Video', plural: 'Videos' },
    admin: { group, useAsTitle: 'title', defaultColumns: ['title', 'creator', 'kind', 'shown', 'publishedAt'] },
    access: { read: readVideos(o), create: createAccess(o), update: curateAccess(o), delete: editAccess(o) },
    defaultSort: '-publishedAt',
    fields: [
      { name: 'title', type: 'text', required: true },
      {
        type: 'row',
        fields: [
          {
            name: 'youtubeId',
            type: 'text',
            required: true,
            index: true,
            validate: (v: unknown) => (isVideoId(v) ? true : 'Not a YouTube video ID.'),
            admin: { width: '30%', readOnly: true },
          },
          { name: 'creator', type: 'relationship', relationTo: o.collections.creators, required: true, index: true, admin: { width: '40%' } },
          { name: 'publishedAt', type: 'date', index: true, admin: { width: '30%', readOnly: true } },
        ],
      },
      {
        type: 'row',
        fields: [
          { name: 'shown', label: 'Shown', type: 'checkbox', defaultValue: false, index: true, admin: { width: '25%' } },
          { name: 'kind', type: 'select', options: o.kinds, index: true, admin: { width: '35%' } },
          { name: 'hiddenReason', type: 'text', admin: { width: '40%', readOnly: true } },
        ],
      },
      {
        name: 'choice',
        label: 'A curator’s choice',
        type: 'select',
        options: [
          { label: 'Always show', value: 'show' },
          { label: 'Always hide', value: 'hide' },
        ],
        admin: { position: 'sidebar', description: 'Wins over every other setting. Clear it to follow the rules again.' },
      },
      ...topicFields,
      { name: 'description', type: 'textarea', admin: { readOnly: true } },
      {
        type: 'row',
        fields: [
          { name: 'duration', type: 'number', admin: { width: '33%', readOnly: true, description: 'Seconds.' } },
          { name: 'thumbnail', type: 'text', hooks: { beforeChange: [imageOnly] }, admin: { width: '67%', readOnly: true } },
        ],
      },
      { name: 'playlists', type: 'text', hasMany: true, admin: { readOnly: true } },
      { name: 'unavailable', label: 'Gone from YouTube', type: 'checkbox', defaultValue: false, index: true, admin: { position: 'sidebar', readOnly: true } },
      { name: 'ruleKey', type: 'text', admin: { hidden: true } },
      { name: 'locked', label: 'Keep my changes', type: 'checkbox', defaultValue: false, admin: { position: 'sidebar' } },
      // New in the plugin (additive, optional; old records still read).
      { name: 'embeddable', type: 'checkbox', admin: { position: 'sidebar', readOnly: true, description: 'From YouTube. When off, the page links out instead of embedding.' } },
      { name: 'madeForKids', type: 'checkbox', admin: { position: 'sidebar', readOnly: true, description: 'From YouTube.' } },
      {
        name: 'source',
        type: 'select',
        options: [
          { label: 'Feed only (no details)', value: 'rss' },
          { label: 'Data API', value: 'api' },
        ],
        admin: { position: 'sidebar', readOnly: true },
      },
      { name: 'channelId', type: 'text', admin: { hidden: true } },
      { name: 'curation', type: 'select', options: ['rules', 'picked'], admin: { hidden: true } },
      { name: 'passedRules', type: 'checkbox', admin: { hidden: true } },
      { name: 'unavailableSince', type: 'date', admin: { hidden: true } },
      { name: 'claim', type: 'text', admin: { hidden: true } },
    ],
    endpoints: [reviewEndpoint],
    hooks: {
      beforeChange: [siteGuard(o, 'curate'), sameSiteCreator(o), videoSyncState(o), personEdits, claimGuard(o), curationFromCreator(o), enforceShown],
      afterChange: [refresh(o, 'videos')],
    },
    indexes: o.scope.field ? [{ fields: [o.scope.field, 'youtubeId'], unique: true }] : [{ fields: ['youtubeId'], unique: true }],
    timestamps: true,
  }
}

function usageBase(o: ResolvedOptions): CollectionConfig {
  return {
    slug: o.collections.usage,
    labels: { singular: 'YouTube units (day)', plural: 'YouTube units' },
    admin: { group: o.labels?.group ?? 'Playlists', useAsTitle: 'day', defaultColumns: ['day', 'units', 'quotaStopped'] },
    access: { read: createAccess(o), create: nobody, update: nobody, delete: nobody },
    fields: [
      { name: 'day', type: 'text', required: true, unique: true, index: true },
      { name: 'units', type: 'number', defaultValue: 0 },
      { name: 'quotaStopped', type: 'checkbox', defaultValue: false },
      { name: 'bySite', type: 'json' },
      { name: 'digests', type: 'json' },
    ],
    timestamps: true,
  }
}


// ---------------------------------------------------------------- the public edges

/** Editors see only their own sites' units; the day's total and the digests are for admins. */
const ownSitesUsage =
  (o: ResolvedOptions): CollectionAfterReadHook =>
  async ({ doc, req }) => {
    if (await isAdmin(o, req)) return doc
    const mine = new Set((await editSites(o, req)).map((s) => siteKey(s)))
    const by = (doc.bySite ?? {}) as Record<string, unknown>
    return { ...doc, bySite: Object.fromEntries(Object.entries(by).filter(([k]) => mine.has(k))) }
  }

function withGuards(c: CollectionConfig, read: unknown, own: string[], nested: Record<string, string[]>, guard: CollectionBeforeOperationHook): CollectionConfig {
  // Every collection gets its guards here, and none can be duplicated (see `noCopy`). `disableDuplicate` also hides the
  // admin's Duplicate button and turns off Payload's duplicate routes.
  return { ...c, disableDuplicate: true, fields: guardFields(c.fields, own, read, nested), hooks: { ...c.hooks, beforeOperation: [noCopy, shapeGuard, guard, ...(c.hooks?.beforeOperation ?? [])], beforeChange: [...(c.hooks?.beforeChange ?? []), shapeGuardChange] } }
}

export function creatorsCollection(o: ResolvedOptions): CollectionConfig {
  const t = topicNames(o)
  return withGuards(creatorsBase(o), staffField(o), INTERNAL_CREATOR_FIELDS, { channels: [...INTERNAL_CHANNEL_FIELDS, ...(o.topics ? [t.mode, t.titles] : [])] }, queryGuard(o, internalPaths(o).creators))
}

export function videosCollection(o: ResolvedOptions): CollectionConfig {
  const t = topicNames(o)
  return withGuards(videosBase(o), staffField(o), [...INTERNAL_VIDEO_FIELDS, ...(o.topics ? [t.names] : [])], {}, queryGuard(o, internalPaths(o).videos))
}

export function usageCollection(o: ResolvedOptions): CollectionConfig {
  const c = withGuards(usageBase(o), staffField(o, 'admin'), ['units', 'digests'], {}, queryGuard(o, internalPaths(o).usage, 'admin'))
  return { ...c, hooks: { ...c.hooks, afterRead: [ownSitesUsage(o), ...(c.hooks?.afterRead ?? [])] } }
}
