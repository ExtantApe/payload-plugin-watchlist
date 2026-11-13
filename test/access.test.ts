import type { CollectionConfig, Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { as, person, startPayload, stopMongo, tokenOf, videoId, type Harness, type Person } from './harness.js'

// Who reads and changes what, through the Local API with access checked and through REST. Made-up sites A and B,
// made-up people and videos. The public reads only shown videos of listed creators that aren't picked-pending.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
let h: Harness
let payload: Payload
let member: Person, curator: Person, staff: Person, admin: Person, curatorB: Person
const ids: Record<string, string> = {}
const tokens: Record<string, string> = {}

const mkCreator = async (key: string, data: Doc) => {
  ids[key] = String((await payload.create({ collection: 'creators', data: { tenant: 'A', name: `Made-up ${key}`, channels: [{ handle: `@${key}` }], ...data } as never })).id)
}
const mkVideo = async (key: string, creator: string, data: Doc = {}) => {
  ids[key] = String((await payload.create({ collection: 'videos', data: { tenant: 'A', creator: ids[creator], youtubeId: videoId(key), title: `Made-up ${key}`, passedRules: true, source: 'api', ...data } as never })).id)
}
const name = (d: Doc) => String(d.title ?? d.name).replace('Made-up ', '')
const seeVideos = async (p: Person | null, site?: string) => (await payload.find({ collection: 'videos', ...as(p, site), pagination: false, depth: 0 })).docs.map((d) => name(d as Doc)).sort()
const restVideos = async (p: Person | null, site?: string) => {
  const r = await h.rest('/videos?limit=100&depth=0', { token: p ? tokens[p.id] : undefined, site })
  return r.status === 200 ? (r.body.docs as Doc[]).map(name).sort() : r.status
}

const PUBLIC_A = ['pickedChosen', 'rulesOk'].sort()
const ALL_A = ['dnfVid', 'gone', 'pickedChosen', 'pickedPending', 'rssOnly', 'rulesHidden', 'rulesOk', 'unlistedVid'].sort()

beforeAll(async () => {
  h = await startPayload((o) => ({
    ...o,
    // An override that tries to open reads to everyone: the plugin's rule must survive it.
    overrides: { videos: (c: CollectionConfig) => ({ ...c, access: { ...c.access, read: () => true } }) },
  }))
  payload = h.payload
  member = await person(payload, 'A')
  curator = await person(payload, 'A', 'curator')
  staff = await person(payload, 'A', 'staff')
  admin = await person(payload, 'A', 'admin')
  curatorB = await person(payload, 'B', 'curator')
  for (const p of [member, curator, staff, admin, curatorB]) tokens[p.id] = await tokenOf(payload, p)
  await mkCreator('rules', { videosDefault: 'rules' })
  await mkCreator('picked', { videosDefault: 'picked' })
  await mkCreator('unlisted', { videosDefault: 'rules', listed: false })
  await mkCreator('dnf', { videosDefault: 'rules', doNotFeature: true })
  await mkCreator('siteB', { tenant: 'B', videosDefault: 'rules' })
  await mkVideo('rulesOk', 'rules')
  await mkVideo('rulesHidden', 'rules', { passedRules: false })
  await mkVideo('gone', 'rules', { unavailable: true })
  await mkVideo('rssOnly', 'rules', { source: 'rss', passedRules: false })
  await mkVideo('pickedPending', 'picked')
  await mkVideo('pickedChosen', 'picked', { choice: 'show' })
  await mkVideo('unlistedVid', 'unlisted')
  await mkVideo('dnfVid', 'dnf')
  await mkVideo('siteBVid', 'siteB', { tenant: 'B' })
})
afterAll(async () => {
  await payload.destroy()
  await stopMongo()
})

describe('reading', () => {
  it('a signed-out visitor sees only shown videos of listed creators of their site, not picked-pending ones', async () => {
    expect(await seeVideos(null, 'A')).toEqual(PUBLIC_A)
    expect(await restVideos(null, 'A')).toEqual(PUBLIC_A)
    expect(await seeVideos(null, 'B')).toEqual(['siteBVid'])
  })

  it('a signed-out visitor with no site sees nothing', async () => {
    await expect(seeVideos(null)).rejects.toThrow(/not allowed/)
    expect(await restVideos(null)).toBe(403)
    await expect(payload.find({ collection: 'creators', ...as(null) })).rejects.toThrow(/not allowed/)
  })

  it('a signed-in member with no role sees what a visitor sees', async () => {
    expect(await seeVideos(member)).toEqual(PUBLIC_A)
    expect(await restVideos(member)).toEqual(PUBLIC_A)
  })

  it('a curator sees every video of their site, and only the public ones elsewhere', async () => {
    expect(await seeVideos(curator)).toEqual(ALL_A)
    expect(await restVideos(curator)).toEqual(ALL_A)
    expect(await seeVideos(curatorB)).toEqual(['siteBVid'])
  })

  it('staff see every video of their site; an admin sees everything', async () => {
    expect(await restVideos(staff)).toEqual(ALL_A)
    expect(await restVideos(admin)).toEqual([...ALL_A, 'siteBVid'].sort())
  })

  it('an unlisted or do-not-feature creator’s videos can’t be read by id through REST', async () => {
    for (const key of ['unlistedVid', 'dnfVid', 'pickedPending']) expect((await h.rest(`/videos/${ids[key]}`, { site: 'A' })).status).toBe(404)
    expect((await h.rest(`/videos/${ids.rulesOk}`, { site: 'A' })).status).toBe(200)
  })

  it('the public sees listed creators only, without those who asked not to be featured', async () => {
    const { docs } = await payload.find({ collection: 'creators', ...as(null, 'A'), pagination: false })
    expect(docs.map((d) => name(d as Doc)).sort()).toEqual(['picked', 'rules'])
  })

  it('the unit ledger is for editors and admins only', async () => {
    expect((await h.rest('/watchlist-usage')).status).toBe(403)
    expect((await h.rest('/watchlist-usage', { token: tokens[curator.id] })).status).toBe(403)
    expect((await h.rest('/watchlist-usage', { token: tokens[staff.id] })).status).toBe(200)
  })
})

describe('changing', () => {
  it('a curator sets a choice on their site’s video, and it shows', async () => {
    const r = await h.rest(`/videos/${ids.pickedPending}`, { method: 'PATCH', token: tokens[curator.id], body: { choice: 'show' } })
    expect(r.status).toBe(200)
    expect(r.body.doc).toMatchObject({ choice: 'show', shown: true, locked: true })
    expect(await seeVideos(null, 'A')).toContain('pickedPending')
    await payload.update({ collection: 'videos', id: ids.pickedPending!, data: { choice: null } as never, overrideAccess: true })
    expect(await seeVideos(null, 'A')).not.toContain('pickedPending')
  })

  it('ticking Shown is a curator’s choice', async () => {
    const doc = (await payload.update({ collection: 'videos', id: ids.rulesHidden!, data: { shown: true } as never, ...as(curator) })) as unknown as Doc
    expect(doc).toMatchObject({ choice: 'show', shown: true })
    await payload.update({ collection: 'videos', id: ids.rulesHidden!, data: { choice: null } as never, overrideAccess: true })
  })

  it('a curator can’t change anything but the review fields, can’t touch another site, and can’t manage creators', async () => {
    expect((await h.rest(`/videos/${ids.rulesOk}`, { method: 'PATCH', token: tokens[curator.id], body: { title: 'Made-up renamed' } })).status).toBe(403)
    expect((await h.rest(`/videos/${ids.siteBVid}`, { method: 'PATCH', token: tokens[curator.id], body: { choice: 'hide' } })).status).toBeOneOf([403, 404])
    expect((await h.rest('/creators', { method: 'POST', token: tokens[curator.id], body: { tenant: 'A', name: 'Made-up new', channels: [{ handle: '@n' }] } })).status).toBe(403)
    expect((await h.rest(`/creators/${ids.rules}`, { method: 'PATCH', token: tokens[curator.id], body: { listed: false } })).status).toBeOneOf([403, 404])
    expect((await h.rest(`/videos/${ids.rulesOk}`, { method: 'DELETE', token: tokens[curator.id] })).status).toBeOneOf([403, 404])
  })

  it('a member and a visitor change nothing', async () => {
    expect((await h.rest(`/videos/${ids.rulesOk}`, { method: 'PATCH', token: tokens[member.id], body: { choice: 'hide' } })).status).toBeOneOf([403, 404])
    expect((await h.rest(`/videos/${ids.rulesOk}`, { method: 'PATCH', site: 'A', body: { choice: 'hide' } })).status).toBeOneOf([403, 404])
    expect((await h.rest('/creators', { method: 'POST', site: 'A', body: { tenant: 'A', name: 'Made-up new', channels: [{ handle: '@n' }] } })).status).toBe(403)
  })

  it('staff manage creators and videos of their own site only, and can’t move a record to another site', async () => {
    const ok = await h.rest('/creators', { method: 'POST', token: tokens[staff.id], body: { tenant: 'A', name: 'Made-up staff creator', channels: [{ handle: '@s' }] } })
    expect(ok.status).toBe(201)
    expect(ok.body.doc.videosDefault).toBe('picked')
    expect((await h.rest('/creators', { method: 'POST', token: tokens[staff.id], body: { tenant: 'B', name: 'Made-up elsewhere', channels: [{ handle: '@s' }] } })).status).toBe(403)
    expect((await h.rest(`/videos/${ids.rulesOk}`, { method: 'PATCH', token: tokens[staff.id], body: { title: 'Made-up rulesOk' } })).status).toBe(200)
    expect((await h.rest(`/videos/${ids.rulesOk}`, { method: 'PATCH', token: tokens[staff.id], body: { tenant: 'B' } })).status).toBe(403)
    expect((await h.rest(`/creators/${ids.siteB}`, { method: 'PATCH', token: tokens[staff.id], body: { listed: false } })).status).toBeOneOf([403, 404])
  })

  it('Shown can’t be set around the rules, even by a system write', async () => {
    const doc = (await payload.update({ collection: 'videos', id: ids.pickedPending!, data: { shown: true } as never, overrideAccess: true })) as unknown as Doc
    expect(doc.shown).toBe(false)
  })

  it('a creator’s mode change re-judges its videos at once', async () => {
    await payload.update({ collection: 'creators', id: ids.picked!, data: { videosDefault: 'rules' } as never, ...as(staff) })
    expect(await seeVideos(null, 'A')).toContain('pickedPending')
    await payload.update({ collection: 'creators', id: ids.picked!, data: { videosDefault: 'picked' } as never, ...as(staff) })
    expect(await seeVideos(null, 'A')).not.toContain('pickedPending')
  })

  it('records changed outside Payload’s hooks still fail closed: a creator set to picked, a video marked gone', async () => {
    const creators = payload.db.collections.creators!
    const videos = payload.db.collections.videos!
    await creators.updateOne({ _id: ids.rules }, { $set: { videosDefault: 'picked' } })
    expect(await seeVideos(null, 'A')).not.toContain('rulesOk')
    await creators.updateOne({ _id: ids.rules }, { $set: { videosDefault: 'rules' } })
    await videos.updateOne({ _id: ids.rulesOk }, { $set: { unavailable: true } })
    expect(await seeVideos(null, 'A')).not.toContain('rulesOk')
    await videos.updateOne({ _id: ids.rulesOk }, { $set: { unavailable: false } })
    expect(await seeVideos(null, 'A')).toContain('rulesOk')
  })

  it('unlisting a creator or marking do-not-feature hides their videos at once', async () => {
    await payload.update({ collection: 'creators', id: ids.rules!, data: { listed: false } as never, ...as(staff) })
    expect(await seeVideos(null, 'A')).not.toContain('rulesOk')
    await payload.update({ collection: 'creators', id: ids.rules!, data: { listed: true, doNotFeature: true } as never, ...as(staff) })
    expect(await seeVideos(null, 'A')).not.toContain('rulesOk')
    await payload.update({ collection: 'creators', id: ids.rules!, data: { doNotFeature: false } as never, ...as(staff) })
    expect(await seeVideos(null, 'A')).toContain('rulesOk')
  })
})
