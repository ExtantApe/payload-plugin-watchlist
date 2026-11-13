import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { syncCreator, type Classified } from '../src/index.js'
import { fakeYoutube } from './fakeYoutube.js'
import { channelId, startPayload, stopMongo, videoId } from './harness.js'

// Topic pages (the site's species pages), with the site's own field names: automatic only for topic playlists, title
// phrases or single-topic channels, and only for topicKinds; everything else waits for review. Made-up topics.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
let payload: Payload
const yt = fakeYoutube()
const topicIds: Record<string, string> = {}

beforeAll(async () => {
  const h = await startPayload(
    (o) => ({
      ...o,
      topics: { relationTo: 'taxa', field: 'species', stateField: 'speciesState', namesField: 'speciesNames', modeField: 'speciesMode', titlesField: 'speciesTitles', playlistRule: 'species', resolve: (name) => topicIds[name] ?? null },
      youtube: { apiKey: () => 'made-up-key', fetch: (...a) => yt.fetch(...a), sleep: async () => {} },
      classify: async (videos) =>
        new Map<string, Classified>(
          videos.map((v): [string, Classified] => {
            if (/two/.test(v.title)) return [v.key, { kind: 'care', topics: ['Madeupus one', 'Madeupus two'], singleTopic: false }]
            if (/build/.test(v.title)) return [v.key, { kind: 'build', topics: ['Madeupus one'], singleTopic: true }]
            return [v.key, { kind: 'care', topics: ['Madeupus one', 'Unknownus'], singleTopic: true }]
          }),
        ),
    }),
    { collections: [{ slug: 'taxa', fields: [{ name: 'name', type: 'text' }] }] },
  )
  payload = h.payload
  for (const n of ['Madeupus one', 'Madeupus two']) topicIds[n] = String((await payload.create({ collection: 'taxa', data: { name: n } as never })).id)
})
afterAll(async () => {
  await payload.destroy()
  await stopMongo()
})

describe('topic pages', () => {
  it('a single-topic channel puts educational single-topic videos on topic pages; builds and several topics wait for review', async () => {
    const ch = channelId('topics')
    yt.addChannel(ch, '@topics')
    yt.upload(ch, { id: videoId('one'), title: 'Made-up care' })
    yt.upload(ch, { id: videoId('build'), title: 'Made-up build' })
    yt.upload(ch, { id: videoId('two'), title: 'Made-up two' })
    yt.upload(ch, { id: videoId('list'), title: 'Made-up two in list' })
    yt.playlist('PLtopic', 'Made-up topic list', [videoId('list')])
    const c = (await payload.create({ collection: 'creators', data: { tenant: 'A', name: 'Made-up', videosDefault: 'rules', channels: [{ handle: '@topics', speciesMode: 'single-species', playlists: [{ playlist: 'PLtopic', rule: 'species' }] }] } as never })) as unknown as Doc
    await syncCreator(payload, c.id)
    const docs = (await payload.find({ collection: 'videos', overrideAccess: true, depth: 0, pagination: false })).docs as unknown as Doc[]
    const by = new Map(docs.map((d) => [d.youtubeId, d]))
    expect(by.get(videoId('one'))).toMatchObject({ speciesState: 'auto', species: [topicIds['Madeupus one']], speciesNames: ['Madeupus one', 'Unknownus'] })
    expect(by.get(videoId('build'))!.speciesState).toBe('review')
    expect(by.get(videoId('two'))!.speciesState).toBe('none')
    expect(by.get(videoId('list'))!.speciesState).toBe('review')
  })
})
