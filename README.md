# payload-plugin-watchlist

Watchlist for Payload: a curated list of YouTube creators for your site, with rules per channel, RSS checks before any Data API call, a daily unit cap, a curator's yes where you want one, and click-to-play youtube-nocookie embeds.

**Status:** phase 2, not on npm, no site uses it. Everything runs on fakes only: 284 tests (2 of them compare against a snapshot that isn't in this repo, and are skipped without it) on Payload 3.92 with an in-memory MongoDB, a made-up YouTube and made-up feeds, and the components in jsdom. Nothing has called YouTube. The admin's review view, its nav link and the Sync now field have never been opened in a real Payload admin, and no page has been seen in a browser or tried with a screen reader. The facts about YouTube's feed (no key needed, about 15 newest uploads, how fast it updates) and YouTube's terms on stored data are not checked yet. Podcasts and shows have their fields but no display or detection yet.

## What it does

- Two collections, `creators` and `videos`, with the slugs and field names the feature had in the site it was moved out of, so a site that had it built in can switch without a database migration. A third, `watchlist-usage`, counts API units a day.
- Each creator has one or more YouTube channels, each with its own rules. In order: live streams, Shorts (up to 61 seconds, or up to 3 minutes with `#shorts`), vertical videos and comment replies are hidden; then videos under the channel's minimum length; then excluded playlists; then videos outside an "include only" playlist; then excluded keywords. What's left goes to your classifier, and only your `shownKinds` pass.
- A creator's "Which videos" is `rules` (videos that pass show on their own) or `picked` (nothing shows until a curator says "Always show"). New creators start at `picked`, so a new creator's videos wait for a curator's yes; a curator can switch a trusted creator to `rules`. A stored creator with no value counts as `picked`. A curator's choice on a video wins over everything.
- The channel's public feed is read first. If it shows nothing new and nothing else is due, a check costs no API units. New videos cost 1 unit per 50 for their details. `search.list` (100 units) is never used.
- Without an API key it still works from the feed alone: new videos are cataloged for review and never shown by the rules, because the feed has no duration or live flag to check.
- Every API call reserves its units first in one atomic database update, so no run goes over the daily cap (2,000 by default), even with two at once. A quota error stops every creator until the next day. A rate limit or YouTube error is tried twice more, after 2 and 8 seconds.
- A weekly re-check marks videos gone from YouTube (never shown while gone) and brings titles up to date; a monthly full read finds old videos made public later. One run per creator at a time.
- Two curators can't both decide the same video. The first decision, from `reviewVideo` or a plain edit, takes an atomic claim; after that only that curator, the site's editors and admins can change the choice. Another curator gets a 409.
- One review digest a day per site when videos wait (nothing for an empty queue), and one at once past 25 waiting, through your `notify`. Each goes at most once a day, and the daily one is skipped on a day the "at once" one already went. A send that fails is tried again on the next run.
- A review queue in the admin (`/admin/watchlist-review`) for curators: every waiting video with "Always show" and "Always hide" buttons named with its title, a player to watch it in place, and a live region that says what was saved or refused. The admin nav shows how many wait.
- A "Sync now" button on each creator, for the site's editors. It reads the creator in full and re-checks its videos, through the same unit ledger, daily cap and run lock, so two clicks run one sync and the second gets "syncing already". A creator rests 10 minutes after any sync before the button works again, and a site can be given its own share of the day's units.
- Server functions and page components for the public pages: the creator list, a creator's page, the video grid, and a video's page with the player. The site mounts them in its own routes.
- The `Player` component shows the thumbnail and a real button named "Play: <title>". YouTube's player (youtube-nocookie.com) loads only after the click, and focus moves to it. A video YouTube won't let be embedded gets a "Watch on YouTube" link instead.

## Access

Only an exact `true` passes. A provider that answers `1`, `'true'`, `{}`, a promise of one of those, or throws, is a no.

| Who | What |
|---|---|
| Signed-out visitor, or signed in with no role | Videos that are shown, not gone, from a listed creator who hasn't asked not to be featured, and either a curator's "Always show" or a `rules` creator, on the visitor's site. Listed creators. With scope and no site, nothing. |
| Curator of a site | Every creator and video of that site, and its review queue; on videos, only `shown`, `choice`, `kind`, `locked` and the topic fields. |
| Editor of a site | Creates, changes and deletes creators and videos of that site, and runs Sync now on its creators. Can't move a record to another site. |
| Admin | Everything. |

"Shown" is recomputed on every write, the sync's included, so it can't be set around the rules through the API. A site's `overrides` can add fields, hooks and narrower access, but can't remove the plugin's fields, hooks or access. The site's own hooks run after the plugin's, including after the one that computes `shown`, so site code can still set `shown` itself: keep that out of your hooks unless you mean it.

A video and its creator must be on the same site; anything else is refused, and the public read checks both.

### What the public can read

Everything not listed here is for an admin and the record's own site's curators and editors only. The public can't read it, filter on it or sort by it: directly, inside `and` and `or`, or through `creator.` on a video.

- **Videos:** `id`, `title`, `youtubeId`, `creator`, `publishedAt`, `shown`, `kind`, `choice`, `description`, `duration`, `thumbnail`, `playlists`, `unavailable`, `embeddable`, `madeForKids`, `createdAt`, `updatedAt`, the topic field and its state (with `topics`), and the site's own fields (its site field, and any it adds by override).
- **Creators:** `id`, `name`, `slug`, `listed`, `website`, `bio`, `avatar`, `videosDefault`, `showsDisplay`, `shows`, and inside `channels` only `handle`, `title`, `channelId` and `playlists`; `createdAt`, `updatedAt`, and the site's own fields. `videosDefault` ("Which videos") is public because a site's own visibility rules read it and filter on it.
- **Not public:** on videos `hiddenReason`, `ruleKey`, `locked`, `source`, `channelId`, `curation`, `passedRules`, `unavailableSince`, `claim` and the classifier's topic names; on creators `doNotFeature`, `doNotFeatureNote`, the schedule (`syncDays`, `syncHour`), the sync's dates, `syncNote`, and in each channel `excludeKeywords`, `minMinutes`, the topic settings, `uploads`, `backfillToken`, `backfillDone`, `rssSeen` and `curation`. Those channel fields are the curators' own rules and the sync's state; no page reads them (confirmed by the maintainers, 2026-11-11). A withheld list field reads as an empty list.
- **Unit ledger:** editors see the day, whether it's stopped, and their own sites' units; the day's total and the digests are for admins. A creator's website takes http and https links only.

## What each site must add

- **A privacy line.** Your privacy page must say that the site uses YouTube API Services: "This site uses YouTube API Services; YouTube's Terms of Service and Google's Privacy Policy apply", with links to both. Thumbnails and avatars load from YouTube's image hosts.
- **A cron.** Call `syncDue(payload)` hourly, after your own secret check, and `sendReviewDigest(payload, { mode: 'daily' })` once a day. With `goneVideos.mode: 'clear'`, also call `sweepGoneVideos(payload)` once a day.
- **Routes for the public pages**, if you use them (see Pages).
- **The import map.** The admin's review view, nav link and Sync now field are registered by the plugin; run `payload generate:importmap` after adding it. They need `@payloadcms/next`, which a Payload admin already has.
- **The key.** Pass it with `youtube.apiKey`. The plugin never reads `process.env`, never logs request URLs, and cuts the key out of every error and note.

## Install or build

Not on npm. In this repo:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Node 22 or later, Payload 3.92 or later, MongoDB (the run lock, the unit ledger and the review claim use atomic MongoDB updates).

```ts
import { watchlist } from '@extantape/payload-plugin-watchlist'

plugins: [
  watchlist({
    scope: { field: 'tenant', ofRequest, sitesFor, isAdmin },
    enabled: (req) => outsideCallsAllowed(),
    youtube: { apiKey: () => yourSecrets.youtubeKey ?? null },
    schedule: { timeZone: 'Europe/Paris' },
    kinds, shownKinds, topicKinds,
    classify: (videos, { req }) => myClassifier(videos),
  }),
]
```

## Options

| Option | Default | What it does |
|---|---|---|
| `scope` | required | `field` (the site field, or leave out on a single-site install), `ofRequest(req)`, `sitesFor(req, 'curate' \| 'edit')`, `isAdmin(req)` |
| `enabled` | required | Outside calls allowed: YouTube, the feed, notices. Only `true` allows any. |
| `youtube.apiKey` | none: feed only | `(req) => key \| null` |
| `youtube.dailyUnitCap` | 2000 | Units a day across every site |
| `youtube.siteDailyUnitCap` | none: a site may use the whole cap | One site's share of the day's units, for all of its runs (the cron's and Sync now). A site at its share stops until the next day; other sites go on. |
| `syncNow.cooldownMinutes` | 10 | How long a creator rests after any sync before a person can run Sync now on it again. 0 turns it off. |
| `youtube.quotaTimeZone` | `America/Los_Angeles` | Where YouTube's day is counted (not checked) |
| `youtube.rss` | `true` | Read the feed first. Turn off if YouTube's terms or robots.txt say no. |
| `schedule` | `UTC`, 12 | The time zone and default hour of each creator's daily check |
| `defaults.videosDefault` | `picked` | A new creator's "Which videos" |
| `curation.level` | `creator` | `channel` adds a per-channel "Which videos" |
| `curation.urgentAt` | 25 | Waiting videos that send the digest at once |
| `goneVideos.mode` | `keep` | `clear` empties YouTube's title, description, thumbnail, duration and playlists of a video gone longer than `clearAfterDays` (30), keeping its ID, the curator's choice, its kind and its topic links. With `keep`, `sweepGoneVideos` does nothing. |
| `kinds`, `shownKinds`, `topicKinds` | a short neutral list | What the classifier may answer, what shows, what may go on topic pages. Pass `kinds` without `shownKinds` and nothing shows by the rules. |
| `topics` | none | Topic pages (`relationTo`, the site's field names, `resolve(name, req)`) |
| `classify` | none: nothing shows by the rules | `(videos, { req })`, each `{ key, title, description, channel }` |
| `classifyDescriptionChars` | 700 | How much of each description the classifier gets; 0 sends titles only |
| `notify` | none | `watchlist.review` and `watchlist.sync-problem` notices |
| `admin` | `{ reviewPath: '/watchlist-review' }` | Where the review view lives under the admin route. `false` leaves the view and its nav link out; Sync now and the two routes stay. |
| `revalidate` | none | Your cache, after a sync or a person's change |
| `overrides` | none | `creators`, `videos`, `usage`: `(collection) => collection` |
| `collections` | `creators`, `videos`, `watchlist-usage` | Slugs |

## Commands

| Export | What it does |
|---|---|
| `syncDue(payload, { now?, budgetMs? })` | The cron: syncs every creator that's due, within 4 minutes by default, then sends the "at once" digest where the queue passed the threshold |
| `syncCreator(payload, id, { full?, recheck?, budget? })` | One creator, now. No access check: for your own server code |
| `syncNow(payload, { req, id })` | Sync now for a person: an editor of the creator's site, or an admin. 401 signed out, 403 without an editor's role, 404 for a creator that doesn't exist or isn't theirs, 409 while a run is going, 429 inside the cooldown (with `retryAfter` in seconds and a `Retry-After` header on the route) |
| `reviewVideo(payload, { req, id, choice })` | A curator's yes or no, with the claim |
| `reviewQueueCount(payload, { req, site? })` | How many videos wait for this person's yes, for a dashboard: their sites for a curator or editor, every site for an admin, 0 for anyone else |
| `sendReviewDigest(payload, { mode: 'daily' \| 'urgent' })` | The digest |
| `sweepGoneVideos(payload, { now?, limit? })` | With `goneVideos.mode: 'clear'`: asks YouTube once more about videos gone longer than `clearAfterDays` (50 a unit, inside the daily cap), clears the details of those still gone and marks the others back. Clears nothing without YouTube's answer |

`syncDue`, `syncCreator`, `sendReviewDigest` and `sweepGoneVideos` are for the site's own cron and server code: they check no person, so call them only after your own check (a cron secret, for example) and never straight from a request.

Two routes, both for signed-in staff only (401 signed out), answering `{ errors: [{ message }] }` on a refusal:

| Route | What it does |
|---|---|
| `POST /api/creators/:id/sync` | `syncNow` |
| `POST /api/videos/:id/review` with `{ "choice": "show" \| "hide" }` | `reviewVideo` |

## Pages

A Payload plugin can't add Next.js routes, so the site mounts the pages in thin route files. Server functions come from `/server`, page components (server components, no hooks) from `/pages`, and the player from `/client`.

```tsx
// app/(frontend)/watch/page.tsx
import { listVideos } from '@extantape/payload-plugin-watchlist/server'
import { VideosPage } from '@extantape/payload-plugin-watchlist/pages'

const paths = { videos: '/watch', creator: (slug: string) => `/watch/c/${slug}`, video: (id: string) => `/watch/v/${id}` }

export default async function Page({ searchParams }) {
  const { page, kind, topic } = await searchParams
  const req = await yourPayloadRequest()
  return <VideosPage result={await listVideos(req, { page, kind, topic })} slots={{ paths, Shell: YourShell, Empty: YourEmpty, TopicFilter: YourTopicFilter, pageHref: (n) => `/watch?page=${n}` }} />
}
```

| Server function | Answers | Page |
|---|---|---|
| `listCreators(req)` | `{ creators }` | `CreatorListPage` |
| `getCreator(req, { slug, page? })` | `{ creator, videos, page, pages, total }` | `CreatorPage` |
| `listVideos(req, { page?, perPage?, kind?, topic? })` | `{ videos, page, pages, total, kinds, kind, topic }` | `VideosPage` (and `VideoGrid` on its own) |
| `getVideo(req, { youtubeId })` | `{ video }` | `VideoPage`, with the click-to-play `Player` |
| `reviewQueue(req, { page?, site? })` | `{ rows, total, page, pages }`, staff only | `ReviewQueue` from `/client` (the admin view uses it) |

- Each answers plain JSON, or `{ error: { code, message } }` with a message a page can show as it is. `isError(result)` tells them apart. Codes: `notFound`, `badInput`, `signIn`, `notStaff`, `generic`.
- The four public functions read as a signed-out visitor of the request's site, whoever is signed in, through the collections' own read access. A curator sees on the public pages what everyone sees. A hidden video, an unlisted creator and one that doesn't exist all answer `notFound`.
- The only filters are `kind` (one of your `kinds`), `topic` (a topic's id; only videos on topic pages automatically or by a curator's yes) and the page. Anything else in the input is ignored or refused.
- Slots, all props: `Shell` (your page layout: it gets `title` and draws the `<main>` and `<h1>`), `Empty` (your empty state), `TopicFilter` (your topic picker above the grid; the plugin doesn't know your topics), `text` (your wording), `locale`, and `paths`, `pageHref`, `kindHref` for links. Each has a plain default except `paths`.
- The pages are one column that widens into a grid, with real headings, lists, `<time>` and named navs, links and buttons at least 44 pixels, and kinds said in words. They store nothing in the browser: no cookies, no web storage.

## On its own, and with others

Watchlist imports no other plugin and needs none. It works with only Payload and MongoDB.

Things it can work with, all optional and wired by the site:
- **Notifications:** pass its send function as `notify`, so curators get the digest and editors hear when a sync stops.
- **AI Budget:** wrap your `classify` with its budget check. Over budget, videos wait unclassified, so they don't show.
- **A multi-tenant plugin:** it adds the site field; Watchlist reads it through `scope`.

## License

MIT. Copyright (c) 2026 EXTANT APE.
