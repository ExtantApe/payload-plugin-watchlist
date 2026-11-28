import { existsSync, readFileSync } from 'node:fs'
import { buildConfig, type Config, type Field } from 'payload'
import { describe, expect, it } from 'vitest'

import { playlists } from '../src/index.js'
import { scope } from './harness.js'

// Field parity, for a site that had this feature built in before the plugin: the plugin's collections, configured as
// that site configures them, carry every field its own collections had, with the same type and the same unique
// indexes, so switching needs no database migration.
//
// The snapshot of that site's fields isn't in this repo: it describes a private codebase. Point
// PLAYLISTS_PARITY_SNAPSHOT at a JSON file to run the comparison; without it the comparison is skipped, and says so.
// The file holds, per collection, `{ fields: { name: type }, uniqueIndexes: [[field, …]] }`, plus `scopeField`, the
// `topics` option (without `resolve`), and `siteOwn`: the fields the site adds itself through `overrides`.
type Snapshot = {
  scopeField: string
  topics?: Record<string, string>
  siteOwn?: Record<'creators' | 'videos', Record<string, string>>
} & Record<'creators' | 'videos', { fields: Record<string, string>; uniqueIndexes: string[][] }>

const path = process.env.PLAYLISTS_PARITY_SNAPSHOT
const snapshot = path && existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Snapshot) : null

/** New in the plugin: additive and optional, so old records still read. */
const NEW = {
  creators: ['doNotFeature', 'doNotFeatureNote', 'rssSeen'],
  videos: ['channelId', 'claim', 'curation', 'embeddable', 'madeForKids', 'passedRules', 'source', 'unavailableSince'],
}
/** Payload's own. */
const PAYLOAD_OWN = ['id', 'createdAt', 'updatedAt', '_order']

function flatten(fields: Field[], out: Record<string, string> = {}): Record<string, string> {
  for (const f of fields as (Field & { name?: string; fields?: Field[]; tabs?: { fields: Field[] }[] })[]) {
    if (f.name) out[f.name] = f.type
    if (f.fields) flatten(f.fields, out)
    if (f.tabs) for (const t of f.tabs) flatten(t.fields, out)
  }
  return out
}

async function build(s: Pick<Snapshot, 'scopeField' | 'topics' | 'siteOwn'>) {
  const own = (slug: 'creators' | 'videos') => Object.entries(s.siteOwn?.[slug] ?? {}).map(([name, type]) => ({ name, type }) as Field)
  const addSiteFields = (slug: 'creators' | 'videos') => (c: { fields: Field[] }) => ({ ...c, fields: [...own(slug), ...c.fields] })
  const addScope = (config: Config): Config => ({ ...config, collections: (config.collections ?? []).map((c) => (['creators', 'videos'].includes(c.slug) ? { ...c, fields: [...c.fields, { name: s.scopeField, type: 'text' }] } : c)) })
  const config = await buildConfig({
    secret: 'test-secret-not-for-production',
    telemetry: false,
    typescript: { autoGenerate: false },
    db: { name: 'none', init: () => ({}) } as never,
    collections: [{ slug: 'users', auth: true, fields: [] }, ...(s.topics ? [{ slug: s.topics.relationTo!, fields: [{ name: 'name', type: 'text' as const }] }] : [])],
    plugins: [
      playlists({
        scope: { ...scope, field: s.scopeField },
        enabled: () => false,
        ...(s.topics ? { topics: { ...s.topics, resolve: () => null } as never } : {}),
        overrides: { creators: addSiteFields('creators') as never, videos: addSiteFields('videos') as never },
      }),
      addScope,
    ],
  })
  return Object.fromEntries(config.collections.filter((c) => ['creators', 'videos'].includes(c.slug)).map((c) => [c.slug, { fields: flatten(c.fields), indexes: (c.indexes ?? []).filter((i) => i.unique).map((i) => i.fields) }]))
}

describe('field parity with a site that had this built in', () => {
  for (const slug of ['creators', 'videos'] as const)
    it.skipIf(!snapshot)(`${slug}: every field of the site is there with the same type, and only the listed new ones are added${snapshot ? '' : ' (skipped: PLAYLISTS_PARITY_SNAPSHOT isn’t set)'}`, async () => {
      const ours = (await build(snapshot!))[slug]!
      const site = snapshot![slug].fields
      const missing = Object.keys(site).filter((n) => !(n in ours.fields))
      const retyped = Object.keys(site).filter((n) => n in ours.fields && ours.fields[n] !== site[n]).map((n) => `${n}: ${site[n]} → ${ours.fields[n]}`)
      const added = Object.keys(ours.fields).filter((n) => !(n in site) && ![...PAYLOAD_OWN, snapshot!.scopeField].includes(n) && !NEW[slug].includes(n))
      expect({ missing, retyped, added }).toEqual({ missing: [], retyped: [], added: [] })
      expect(ours.indexes).toEqual(snapshot![slug].uniqueIndexes)
    })

  it('on its own the plugin’s unique indexes are the scope field with the slug, and with the YouTube ID', async () => {
    const ours = await build({ scopeField: 'site' })
    expect(ours.creators!.indexes).toEqual([['site', 'slug']])
    expect(ours.videos!.indexes).toEqual([['site', 'youtubeId']])
    expect(ours.creators!.fields.syncNow).toBe('ui')
  })
})
