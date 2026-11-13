# 0001: Watchlist design record

Status: **proposed, for the Plugins Lead's review** (2026-11-11). Phases 1 and 2 are built, on fakes; see `docs/decisions.md` for what the build chose. The owner's answers are under Open.

## Context

Watchlist was moved out of a site that had this feature built in: a curated list of YouTube creators, with their
videos sorted, filtered and shown on the site and on its topic pages. This record describes the plugin, not that site.

The owner named the plugin on 2026-11-10: Watchlist, `@extantape/payload-plugin-watchlist`, for media sources,
creators and curation.

The standing rule for these plugins (the owner, 2026-11-10): each is its own agnostic plugin that doesn't depend on
the others but works with them, built with the best architecture first. So Watchlist imports no other plugin. Links
to them are optional adapters.

Children may use a site that runs it. That shapes three defaults below: a curator's yes where a site wants one, no
tracking embeds, and access that fails closed.

## Where it starts from

The feature the plugin replaces had two collections (`creators` and `videos`), a Data API client, a sync with
per-channel rules and a classifier, schedules, a review screen in the admin, a Sync now button and public pages. Three
things about it shaped the design:

- **It had no RSS.** Every check was a Data API call.
- **Videos could show without a person's yes.** The sync set `shown` on its own when the rules and the classifier
  passed. A curator's yes was needed only for a creator set to "Only videos a curator picks".
- **Its database is MongoDB**, with a site field from a multi-tenant plugin at the start of both unique indexes.

## Decision

`@extantape/payload-plugin-watchlist` owns the general job: follow chosen YouTube channels, apply each channel's
rules, keep a catalog of their videos, and show only what a curator has let through. A site plugs in what's specific to
it through providers: its tenancy and roles, how a video is typed, what topic pages a video can go on, its wording and
its cache.

Fetching is RSS first, with the Data API only where RSS can't answer. The API key is passed in by the site; the plugin
never reads env.

A general Payload plugin, so MIT. The owner agreed on 2026-11-11 to make it
public at its first release, through the audited first push. 0.x until it has seen real use.

YouTube first. The collections say `youtubeId` and the site's fields stay as they are, so a second source (Vimeo,
PeerTube) would be a later, additive design, not something to shape around now.

## What the plugin owns and what a site keeps

**In the plugin:**
- the `creators` and `videos` collections, their hooks (alphabetical placement, "a person's edit locks the video",
  "choice and Shown agree") and access;
- the YouTube client, the RSS reader, the rules, the sync, schedules, re-check, full read and run lock;
- podcasts and shows, and the check that images come only from YouTube's hosts;
- Sync now and the cron's function, minus any secret and the key, which the site passes in;
- the review view in the admin, its nav link and the Sync now button;
- server functions and React components for the public pages: the list, filters, the video card, the player and the
  creator cards. The site mounts them in thin route files, because a Payload plugin can't add Next.js routes.

**In the site:**
- the route files, the menu entry and any topic page that shows a topic's videos;
- the classifier: its prompt, its "about our subject" rule and its kinds, through the `classify` provider;
- the topics: the collection they live in and how a name becomes a topic, through the `topics` option;
- tenancy and roles, through the `scope` provider;
- whether outside calls are allowed, the API key and the cron's secret, passed in as functions;
- the cron's schedule;
- translations: the plugin ships English strings;
- the site-wide setting for podcasts and shows.

## Collections

The slugs and field names are the ones the feature had before it became a plugin, so a site that had it built in can
switch with no database migration. Fields marked **new** came with the plugin; they're additive and optional, so old
documents still read.

### `creators`

| Field | Type | Notes |
|---|---|---|
| (the site's own) | site fields | a site adds its own fields, such as identity or archive fields, through `overrides.creators` |
| `name`, `slug` | text, slug | unique per site (`[tenant, slug]` index when `scope` is set, else `slug`) |
| `listed` | checkbox | shown on the site's pages |
| `website`, `bio`, `avatar` | text | `avatar` from YouTube's image hosts only |
| `videosDefault` | select `rules` \| `picked` | "Which videos". See curation: the plugin's default for a **new** creator is `picked` |
| `showsDisplay` | select `inherit` \| `keep` \| `own` \| `hide` | this creator's podcasts and shows |
| `shows[]` | `playlist`, `name`, `kind` (`podcast` \| `show`), `display`, `logo`, `detected` | podcasts and shows |
| `channels[]` | `handle`, `title`, `channelId` | one or more YouTube channels |
| `channels[].speciesMode` | select `review` \| `single-species` \| `never` | topic pages; the name is the site's, kept by option |
| `channels[].playlists[]` | `playlist`, `rule` (`include` \| `exclude` \| `species` \| `show`), `title`, `showName` | playlist rules; `show` and `showName` are the pre-2026-11-10 form, read and moved by the sync as today |
| `channels[].excludeKeywords`, `minMinutes`, `speciesTitles` | textarea, number, textarea | rules |
| `channels[].uploads`, `backfillToken`, `backfillDone` | hidden | sync state |
| `channels[].rssSeen` | hidden text, **new** | the newest video ID seen in the channel's feed |
| `channels[].curation` | select `inherit` \| `rules` \| `picked`, **new, optional** | only if the owner wants the yes per channel (open question 2) |
| `syncDays`, `syncHour` | select (many), number | the schedule, in the site's time zone |
| `lastSyncedAt`, `lastRecheckAt`, `lastFullSyncAt`, `syncingSince`, `syncNote`, `syncNow` | | sync state and the button |
| `doNotFeature` | checkbox, **new** | a creator asked not to be featured: the sync stops, nothing of theirs shows, and the reason stays on record (see publishers' terms) |

### `videos`

| Field | Type | Notes |
|---|---|---|
| (the site's own) | site fields | by override |
| `title`, `youtubeId`, `creator`, `publishedAt` | | `[tenant, youtubeId]` unique |
| `shown`, `kind`, `hiddenReason` | checkbox, select, text | `kind` options come from the `kinds` option |
| `choice` | select `show` \| `hide` | a curator's choice, wins over everything |
| `species`, `speciesState`, `speciesNames` | relationship, select, text (many) | the topic fields: added only when the `topics` option is set, with the site's names |
| `description`, `duration`, `thumbnail`, `playlists` | | from YouTube |
| `unavailable` | checkbox | "Gone from YouTube" |
| `ruleKey`, `locked` | hidden text, checkbox | re-judging and "Keep my changes" |
| `embeddable` | checkbox, **new** | from `status.embeddable`; when false the page links out instead of embedding |
| `source` | select `rss` \| `api`, **new** | where the details came from; RSS-only videos never show on their own (see fetching) |

### Site-specific fields: options and overrides

- `collections: { creators: 'creators', videos: 'videos' }`: slugs, with these as the defaults.
- `overrides: { creators?, videos?, usage? }`: the site adds its own fields and hooks. The plugin merges them and never
  removes its own access or hooks.
- `kinds`, `shownKinds`, `topicKinds`: the site passes its own. The plugin's defaults are a short neutral list.
- `topics`: optional. `{ relationTo: 'taxa', field: 'species', stateField: 'speciesState', namesField: 'speciesNames',
  modeField: 'speciesMode', titlesField: 'speciesTitles', playlistRule: 'species', filterOptions, resolve: (name, req) =>
  id | null }`. The plugin's own words are "topic pages"; a site keeps its own field names and labels.
- `labels`: the site's own wording and admin group.

A field-parity test compares the plugin's collections, configured as such a site configures them, against a snapshot
of that site's fields, so a renamed field fails before it can need a migration. The snapshot isn't in this repo; the
test reads it from a path in `WATCHLIST_PARITY_SNAPSHOT` and is skipped without it.

## Per-channel rules

Unchanged from the site, in this order, each with the `hiddenReason` the review screen shows:

1. live, upcoming or past live stream;
2. a Short (up to 61 seconds, or up to 3 minutes with `#shorts`), a vertical video, a reply to a comment;
3. shorter than the channel's `minMinutes`;
4. in an excluded playlist;
5. not in an included playlist, when the channel has any (species playlists count as included);
6. mentions an excluded keyword in the title or description.

Then the `classify` provider types the rest. Only `shownKinds` pass, and the site's provider can also say "not about
our subject". A video's `ruleKey` hashes the channel's rules and a `RULES_VERSION`, so a changed rule
re-judges stored videos before older history. A `locked` video, one a person has edited, is never changed by the sync,
except for YouTube's own title, description and thumbnail on the re-check.

Podcasts and shows keep their four levels (video, show, creator, site), most specific first.

## Fetching: RSS first

The plugin reads the channel's public feed first, and calls the API only when
the feed shows something new or when only the API can answer.

The feed is `https://www.youtube.com/feeds/videos.xml?channel_id=<id>`. Not verified for this design (no call to
YouTube was made): that it needs no key, that it lists about the 15 newest uploads, that it includes Shorts and
livestreams, whether it sends `ETag` or `Last-Modified`, how quickly it updates, and whether `playlist_id=` feeds work
the same way. The build checks each of these once, by hand, on a test site, and writes down what it found.

| Step | Source | Cost |
|---|---|---|
| Channel ID from a handle, once | Data API `channels.list forHandle` | 1 unit. A curator can paste a channel link with the ID instead, which costs nothing |
| "Anything new?" on each scheduled check | RSS | none; a conditional request if YouTube supports it |
| Details of new videos: duration, live, vertical, embeddable | Data API `videos.list`, 50 IDs a call | 1 unit per 50 |
| Back catalog, monthly full read, weekly re-check | Data API `playlistItems.list`, `videos.list` | 1 unit per 50 |
| Rule and podcast playlists | Data API `playlistItems.list` | 1 unit per 50; read on full reads, re-checks and when the feed has new videos, not on every run |
| Podcasts YouTube marks | Data API `playlists.list part=snippet,status` | 1 unit per 50 playlists; on full reads only |
| `search.list` | never | it costs 100 units a call |

When the feed shows nothing new, rules haven't changed and no re-check or full read is due, a scheduled check costs
**no units**. That's most days for most creators.

**Without a key**, the plugin still works in RSS-only mode: it catalogs new videos from the feed with `source: 'rss'`.
The feed has no duration, live flag or shape, so rules 1 to 3 can't be checked. Those videos are never shown by rules:
they go to review, and only a curator's "Always show" puts them up. No back catalog, re-check or podcast detection
without a key. The admin says so in plain words on the creator.

**The key** is passed in: `youtube: { apiKey: (req) => string | null }`. The plugin never reads `process.env`, and a
test proves it (a key in env and none passed means no API call). The key goes in the request's query string, as the
API requires, so the plugin never logs request URLs, and its errors carry YouTube's message, never the URL.

**Outside effects:** `enabled: (req) => boolean`, the site's own switch for outside calls. Only an exact `true`
allows any outside call, RSS included. Tests run with it off and a fetch that throws if called.

## Quotas and cost

Working numbers, from notes and not from Google's current quota table (unverified):

| | Number |
|---|---|
| Daily quota | 10,000 units |
| Each list call used | 1 unit per page of 50 |
| `search.list` | 100 units, never used |
| Without RSS, per creator, per day | about 3 to 10 units |
| Weekly re-check | about 1 unit per 50 stored videos |
| Sync now | about 25 units for a creator with about 600 videos |
| Per run | 150 videos per creator; 4 minutes for the hourly cron; a 15-minute run lock |

When the daily quota resets (Pacific midnight, from memory) is also unverified.

With RSS first, a typical day should drop to the units spent on new videos plus whatever re-checks and full reads fall
due. That's an estimate, to be measured on a test site after the build.

**What the plugin adds:**
- **A unit ledger:** each API call records its estimated units, by site and day, on a small `watchlist-usage`
  collection (**new**, its own slug, so nothing existing changes). The admin shows today's units.
- **A cap:** `youtube.dailyUnitCap`, default 2,000, well under the quota so other uses of the same Google project keep
  room. At the cap, runs stop cleanly with a note and continue the next day.
- **Backoff:** a quota error (`quotaExceeded`, `dailyLimitExceeded`) stops every creator until the next reset, rather
  than trying again each hour. A rate-limit or 5xx error is retried twice in the run, after 2 and 8 seconds,
  then the creator waits for its next slot. An RSS failure falls back to the API path for that run.
- **Caching:** channel IDs, upload playlist IDs and playlist titles are stored on the creator. Playlist
  membership is cached between full reads. Public reads stay cached for an hour, refreshed by the site's `revalidate`
  callback after a sync or a person's change.
- **AI cost:** the classifier is the site's, so its cost is the site's. With the AI Budget adapter, each classify call
  can be checked against a budget first; over budget, the videos wait unclassified, so they don't show.

## Curation and moderation

Children may use the site, so **nothing appears publicly without a curator's yes, unless the site says so for that
creator**.

- A new creator starts at `videosDefault: 'picked'`: only videos a curator sets to "Always show" appear. The rules and
  the classifier still sort the rest into the review queues, so a curator works a short list, not the whole channel.
- A curator, or the site through `defaults.videosDefault`, can set a creator to `rules`: then videos that pass the
  rules and the classifier show on their own.
- A missing or unknown value means `picked`. A site that had the feature built in, and treated a missing value as
  `rules`, sets stored values on purpose before it switches (on a throwaway copy of its data first), so nothing that
  shows disappears.
- A video's `choice` wins over everything. "Always hide" also wins over `rules`.
- RSS-only videos, unclassified videos, and videos the classifier couldn't parse never show by rules.
- Topic pages are stricter: automatic only for the site's topic playlists, title phrases or single-topic
  creators, and only for `topicKinds`; everything else waits for review.
- Gone videos never show and are never deleted while the site keeps them (see the publishers' terms for the question
  this raises).

**Enforced where it can't be skipped.** The "picked" rule isn't left to the page queries. The sync computes `shown` from the rules, the creator's mode and the video's choice, and the public `read`
access for signed-out visitors requires all of: `shown` true, `unavailable` not true, a listed creator that isn't
`doNotFeature`, and the visitor's site. A creator's mode change or a
`listed` change re-judges its videos in the same transaction.

## Privacy

- **No tracking embeds by default.** The player is `https://www.youtube-nocookie.com/embed/<id>`,
  with `referrerpolicy="strict-origin-when-cross-origin"`.
- **Click to play (proposed default).** The video page shows the thumbnail and a play button. The iframe loads only
  after a click, so a visit alone doesn't load YouTube's player. The site can turn this off (`player.loadOnClick:
  false`).
- The play button is a real `<button>` with the video's title in its label, reachable by keyboard, with a visible focus
  ring. The iframe has a `title`.
- **Images:** thumbnails and avatars only from YouTube's own image hosts over https (`youtubeImage`, kept), with
  `alt=""` where the title is beside them. Each image still loads from Google's servers. A thumbnail proxy is an open
  question.
- **No visitor data:** the plugin stores nothing about visitors: no view counts, no watch history, no cookies.
- A "Watch on YouTube" link stays on each video, with `rel="noopener"`.

## Access: fail closed

Only an exact `true` passes. A provider that returns `1`, `'true'`, an object, a promise of one of those, or throws,
is a refusal. Each gate is wrapped once (`gate(fn)`), and the wrapper is tested with each of those values.

| Who | What |
|---|---|
| Signed-out visitor | read listed creators and shown videos of the current site, as above. Nothing else |
| Signed-in, no role | the same as a visitor |
| Site curator (`scope.canCurate`) | update videos of their site: `shown`, `choice`, `kind`, the topic fields. Not creators |
| Site editor (`scope.canEdit`) | create, update and delete creators and videos of their site; Sync now |
| Platform admin (`scope.isAdmin`) | everything, every site |
| The cron | `cron.authorize(req)` returning exactly `true`, which the site implements, for example as a constant-time bearer check |

The scope provider:

```ts
scope: {
  field: 'tenant',                                             // or omit on a single-site install
  ofRequest: (req) => Promise<SiteId | null>,                   // the visitor's site; null means nothing is readable
  sitesFor: (req, role: 'curate' | 'edit') => Promise<SiteId[]>, // anything but an array is an empty one
  isAdmin: (req) => Promise<boolean>,
}
```

The plugin builds every `Where` itself from those answers. A provider never returns a `Where` the plugin passes
through. The review view refuses when `sitesFor(req, 'curate')` is empty and the viewer isn't an admin. Sync now and
the review view's edits use the viewer's own access (`overrideAccess: false`). Only the sync writes with
`overrideAccess: true`, and only to the creator it was asked to sync, inside that creator's site.

## Providers and adapters

The shapes are sketches, made exact when the code is written.

```ts
watchlist({
  collections: { creators: 'creators', videos: 'videos' },
  overrides: { creators: { fields: [...] }, videos: { fields: [...] } },
  scope: { ... },                                              // above
  youtube: { apiKey: (req) => string | null, dailyUnitCap: 2000 },
  enabled: (req) => boolean,                                   // outside calls allowed; exact true only
  cron: { authorize: (req) => boolean, budgetMs: 240_000 },
  schedule: { timeZone: 'UTC', defaultHour: 12 },    // the site passes its own zone
  defaults: { videosDefault: 'picked' },
  kinds, shownKinds, topicKinds,
  topics: { ... },                                             // optional
  classify: (videos, { req }) => Promise<Map<string, Classified>>, // optional; without it nothing shows by rules
  siteShowsDisplay: (req) => Promise<'keep' | 'own' | 'hide' | null>,
  revalidate: ({ site, tag }) => void,                         // the site's cache; the plugin doesn't import next/cache
  player: { loadOnClick: true },
  i18n: { t: (key, vars) => string },                          // English built in
  adapters: { notifications?, docs?, aiBudget?, auditTrail?, seed? },
})
```

**Adapters, all optional, none imported:**
- **Notifications** (`payload-plugin-notifications`): tell a site's curators when the review queues grow past a
  threshold, and tell editors when a sync stops (quota, cap, a channel not found). Kinds `watchlist.review` and
  `watchlist.sync-problem`, so people can turn them off.
- **Docs** (`payload-plugin-docs`): a feature page for curators: how rules, curation levels and the
  queues work. The plugin provides the content; Docs publishes it.
- **AI Budget** (`payload-plugin-ai-budget`): wraps the `classify` call with a budget check and records its cost.
- **Audit Trail** (`payload-plugin-audit-trail`): records who changed a video's `choice`, `shown` or topic fields.
- **Seed** (`payload-plugin-seed`): made-up creators and videos for demos and tests, with no YouTube calls. Low priority.
- **Wikipedia** (same family): nothing planned.

## Publishers' terms and refusals

The rule here: respect a publisher's refusal; don't work around it. None of the YouTube terms points below were
checked against the current text for this design. **All are unverified** and need a read of the YouTube API Services
Terms of Service and Developer Policies before the build.

- **Stored data and refreshing.** The policies are understood to limit how long API data may be kept without
  refreshing (30 days, from memory). The weekly re-check refreshes what's kept, but a gone video's title and
  description are kept indefinitely on purpose (owner, 2026-11-10, so a curator's choice survives its return). This
  may conflict. Open question 3.
- **Deleted or private videos.** The policies are understood to require removing data for content that's no longer
  available. Same question.
- **The embedded player.** It must not be changed, covered or made to autoplay with sound. Click to play with a
  thumbnail first is believed to be fine, but is unverified.
- **Embedding turned off.** When a video's `status.embeddable` is false, the plugin links out and doesn't embed.
- **Made for kids.** `status.madeForKids` is stored if it costs nothing extra (unverified) so the site can decide what
  to do with it. YouTube limits some player features on those videos.
- **A privacy notice.** The site's privacy page is understood to need to say it uses YouTube API Services and link to
  Google's privacy policy. For each site.
- **Sending titles and descriptions to Claude** to type them: whether that's allowed under the policies is unverified.
  Open question 4.
- **The RSS feed.** Not part of the Data API. Whether its use is covered by YouTube's general terms, and whether
  `robots.txt` allows `/feeds/`, is unverified. Read once at the start of the build; if either says no, the plugin
  stays API-only.
- **A creator who asks not to be featured.** `doNotFeature` stops the sync for that creator and hides everything of
  theirs at once, and it can't be cleared by a sync. A creator's own channel settings (private, deleted, embedding off)
  are always followed.
- **No endorsement.** Nothing on the page suggests YouTube or the creators endorse the site.

## Tests planned

The same harness as the other plugins: Vitest, Payload 3.92 on `mongodb-memory-server`, made-up creators and videos,
a fake YouTube client and fake feeds, and a global `fetch` that throws if anything tries the network.

**Carried over from the feature's own tests**, with the same
meaning: the rules; no duplicates; a person's decision kept through syncs; a later playlist rule applied to stored
videos; curators edit their site's videos and nothing more; alphabetical placement; signed-out visitors see only shown
videos of listed creators of their site; all four podcast and show levels; the old "Own filter" move; podcast
detection once; picked-only creators; choice and Shown agreeing; full reads, the re-check, gone videos and their
return; the run lock; image hosts; the schedule (default, days and hour, catch-up, bad values).

**New, always covered:**
- Access fails closed: each gate given `1`, `'true'`, `{}`, a resolved non-`true`, a throw and `undefined`; a
  `sitesFor` returning a non-array; anonymous with no site.
- A signed-out visitor can't read an unlisted or `doNotFeature` creator's videos through the REST API.
- A new creator defaults to `picked`; a missing `videosDefault` acts as `picked`; nothing shows until a curator's yes.
- RSS-only and unclassified videos never show by rules.
- No env reads: a key in `process.env` and none passed means no API call.
- `enabled` not exactly `true` means no outside call at all, RSS included.
- The key never appears in a log line, a sync note or an error.
- Quota: the cap stops runs cleanly; a quota error stops every creator until the reset; retries back off.
- RSS: a made-up feed parsed; nothing new means no API call; a broken feed falls back to the API.
- The player: `youtube-nocookie.com` only; no iframe before the click when `loadOnClick` is on; `embeddable: false`
  links out; the play button has an accessible name.
- Field parity: for a site that had the feature built in, the collections as it configures them match a snapshot of
  its fields and indexes (kept outside this repo).

**Skipped as overkill:** Payload's own field validation, the Mongo adapter, and rendering details a component test
already covers.

**Only on a real test site, at the switch:** the RSS facts above, one real Sync now, and a day's unit count.

## Switching a site that had this built in

1. The plugin is released at 0.x and installed at an exact version.
2. On a throwaway copy of the site's data: set creators with no stored `videosDefault` to `rules`, so nothing visible
   changes. Then compare the schema and indexes before and after.
3. One change in the site: its providers; its own code reduced to the classifier and the topic link; its collections,
   routes and admin view removed and taken from the plugin; its route files mounting the plugin's components; its own
   tests kept and passing.
4. A security read of the plugin before it's public.

## Open

For the owner, answered 2026-11-11:
1. **The default for new creators: `picked`.** A new creator's videos wait for a curator's yes, as proposed under
   "Curation and moderation" above. A curator can switch a trusted creator to `rules`, and then videos that pass the
   rules and the classifier show on their own. The owner first chose `rules` and changed it to `picked` the same day,
   before the first release. A stored creator with no value still counts as `picked`.
2. **Per creator.** `channels[].curation` exists only with `curation.level: 'channel'`.
3. **Gone videos:** delete stored details of gone videos, keeping only the site's own notes, if YouTube's terms call
   for it. The terms are still unread, so `goneVideos.mode` defaults to `keep`; `clear` is built and tested.
4. **Typing videos with a language model:** yes, titles and descriptions only.
5. **Public at first release:** yes, MIT, through the audited first push with the leak check in CI.

Answered by the first site to use it, 2026-11-11 (see `docs/decisions.md`):
6. Click to play on the video page: on by default.
7. Video reads need a listed creator.
8. A thumbnail proxy, so list pages don't load images from Google: not now; revisit if a privacy page needs it.
9. The privacy page line about YouTube API Services: each site adds it.
10. One daily digest when videos wait, and one at once past 25 waiting.

For the build:
11. The RSS facts listed under fetching, checked once by hand on a test site.
12. The current YouTube terms points listed above.
