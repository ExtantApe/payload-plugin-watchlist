# Test audit

Newest first.

## 2026-11-28: after the rename to Playlists

- **Promises:** the package, factory, types, options key, default usage slug, notice kinds, review view and path, data attributes and context key carry the new name; the old context key gives a write nothing; a site that keeps its ledger with `collections: { usage: 'watchlist-usage' }` keeps today's unit count.
- **Added** (4 tests): `test/units.test.ts`, the names a site depends on (`config.custom.playlists` and no `config.custom.watchlist`, the `playlists-usage` slug, `SYNC_CONTEXT`, the review view, its path and import map entry); `test/personWrites.test.ts`, a person's Local API create and update carrying `{ watchlistSync: true }`, with access checked and overridden (2 tests); `test/staff.test.ts`, a kept `watchlist-usage` ledger already at the cap, where the sync stops with `cap` and spends 0 units. The last one guards behaviour the `collections` option already had, so it isn't expected to fail on the old code.
- **Tightened:** two checks could have passed without testing anything after a rename. `test/harness.ts` now builds indexes from the plugin's own collection list and fails if one is missing. `test/duplicate.test.ts` now refuses every GraphQL mutation that starts with `duplicate`, apart from those of Payload's own `duplicatePayload…` collections.
- **Renamed:** the parity snapshot's variable is now `PLAYLISTS_PARITY_SNAPSHOT`. The comparison was skipped.
- **Mutations:** the old and new strings in `scripts/mutate.py` follow the rename. Dry run only: 141 of 142 entries find their line. "S2: people never write the claim" doesn't, as before the rename, and is left as it was.

## 2026-11-28: after checking the shape of write data

- **Promises:** a create or update on `creators`, `videos` or `watchlist-usage` is refused with a 400 when its data has a key that starts with `$` or contains a dot (json and rich text field contents excepted), or when one list has two rows with the same id, for every write, server code included; a list field takes a list, `null`, `0` or `'0'`, and anything else gets the same refusal; a refused write changes nothing; a channel row pointed at a different channel starts its sync over, and a row that resolves to the same channel keeps its state.
- **Added** (`test/writeShape.test.ts`, 36 tests): refusals over REST and the Local API with and without a person, the same answer for an id no record has, nothing changed or created, bulk updates, rows and the top level, the unit ledger, repeated row ids, data added by hooks that come after Watchlist's, a json field, GraphQL create and update, a moved channel row through the API and a whole-record save, the same channel under another link, reordered rows, and a draft save and restore. Also list fields sent as something else (an object, text, false) as staff over REST PATCH and POST, through the Local API with access checked for update and create, and with no person; 0 and '0' saved as an empty list at the top level and inside a row, over REST PATCH and POST; stored sync state kept when a row carries '0'; and null still clearing a list.
- **Added** (`test/shapeWalk.test.ts`, 11 tests): the check called directly over groups, tabs, layout fields, inline and referenced blocks, localized fields, fields it doesn't walk, row ids and data that isn't an object.
- **Covered** (`test/personWrites.test.ts`): the same refusal and message for data outside the fields' shape, at each of three ways in, with the record unchanged on update.
- **Mutations:** the nine new `scripts/mutate.py` entries were each caught by `test/writeShape.test.ts`, in a copy. The entries for `src/collections.ts`, `src/noCopy.ts` and `src/plugin.ts` were rerun: 23 of 25 caught. The other two are older entries that need a look: one no longer finds its line, and one survives its tests. Entries for other files weren't rerun.
- **Not tested:** the SQL adapters, the admin in a browser, GraphQL through its HTTP route, and other Payload versions.

## 2026-11-27: after keeping the sync's and the review's fields to themselves

- **Promises:** a write with a person on the request never sets the fields the README lists as the sync's and the review's, on create or update; the stored values stay; the settings and notes people write are still theirs; the sync, the review, the sweep and server writes still set everything; the plugin's own writes don't change how the caller's later writes are treated.
- **Covered** (`test/personWrites.test.ts`): creates and updates of both collections by staff and an admin over REST, the Local API and the Local API with access overridden; each listed field, on the creator and on existing and new channel rows; the do-not-feature note and the other people settings kept; a whole record saved back; a curator still refused; a curator's claim on a video a person created; one REST request over several creators; later writes on the same request after a re-judging change, a sync and a sweep; server writes with no person and a person-started sync.
- **Gaps skipped:** GraphQL (it runs the same collection hooks), the admin in a browser, the SQL adapters. A site's own hooks are site code and aren't tested here. No new `scripts/mutate.py` entries, and the older ones weren't rerun.

## 2026-11-27: after turning duplicating off

- **Promises:** none of the three collections can be duplicated by anyone, server code included, through any of Payload's ways in; the answer doesn't depend on the id; the site's config can't turn it back on; ordinary creates work as before.
- **Covered** (`test/duplicate.test.ts`): the flag on all three; `payload.duplicate` and `create` with `duplicateFromID` (real, unknown, malformed and empty ids) for a visitor, a member, a curator, editors of both sites, an admin and server code, with record counts unchanged; no REST route and no GraphQL mutation; with a later plugin and every override turning the flag off, the startup rule, the host's `onInit`, a later hook that sets `duplicateFromID`, and Local, REST and GraphQL with the flag off while running; editor and server creates still work; a direct create of each collection is refused for people without the role on that site.
- **Gaps skipped:** GraphQL over its HTTP route (the harness has none; the resolvers are run from the built schema), the admin in a browser and the SQL adapters. The older mutation entries weren't rerun; the four new ones were each caught, in a copy of the repo.

## 2026-11-26: sweep after the transaction fix and 0.1.0

The only source change since the last entry is c924087 (`getCreator` and `getVideo` stop paginating their lookups). The
rest of this sweep maps what the README and `docs/decisions.md` promise at 0.1.0 to the tests that prove it. Still on
fakes only, as before. Test names are shortened where they're long.

- **Promises** (README and `docs/decisions.md`):
  - Transactions: a find that carries a request, and so can run inside its transaction, sends no count, unless it pages for a person.
  - Access: only an exact `true` passes; the public, curator, editor and admin rows of the README's table; a record never moves or points across sites; `shown` can't be set around the rules; overrides only narrow.
  - What the public can read: the listed fields only, with filters and sorts on the others refused, in `and`/`or` and through `creator.`.
  - Public pages: read as a signed-out visitor whoever is signed in; hidden, unlisted and missing all answer `notFound`; only the named filters; plain JSON with no detail of a failure; nothing kept in the browser.
  - The sync: the rules in order, `picked` by default, RSS first, feed-only without a key, the daily cap and a site's share, the quota stop, retries, the re-check, the run lock, the cron.
  - The key and outside calls: the key is never read from env and never appears in a note or error; `enabled` anything but `true` means no outside call.
  - Curation: one curator decides (the atomic claim), people never write the claim, the review queue and its count, the digest.
  - Sync now: who may run it, the refusals, the 409 and the 429.
  - Gone videos: `keep` does nothing; `clear` clears only on YouTube's fresh answer.
  - The player: no iframe before the click, youtube-nocookie only, a link out when embedding is off.
- **Covered:**
  - Transactions, the fix: `transactions.test.ts`: "a creator's page: the lookup by slug sends no count; only the list that pages for the visitor does" and "a video's page: its one find sends no count".
  - Exact `true`: `units.test.ts`: "exactlyTrue refuses ...", "isAdmin answering ... grants nothing", "sitesFor answering ... is no role", "ofRequest answering ... means no public reads"; `staff.test.ts`: "a provider that answers anything but what's asked is a no".
  - The access table: `access.test.ts`: all of "reading" and "changing", including "a signed-out visitor with no site sees nothing", "a curator can't change anything but the review fields, can't touch another site, and can't manage creators", "staff manage creators and videos of their own site only, and can't move a record to another site" and "the unit ledger is for editors and admins only".
  - Across sites: `security.test.ts`: "refuses a site-A video pointing at a site-B creator, for staff and for a system write" and "a stored cross-site video never shows publicly, and a mode change re-judges only the creator's own site".
  - `shown` and fail closed on stored records: `access.test.ts`: "Shown can't be set around the rules, even by a system write", "records changed outside Payload's hooks still fail closed", "unlisting a creator or marking do-not-feature hides their videos at once".
  - Overrides: `units.test.ts`: "a removed field or a changed type is refused", "access is only narrowed, and the plugin's hooks run first", "the plugin's routes stay, and stay first".
  - What the public can read: `security.test.ts`: all of "B1: internal fields"; `pages.test.ts`: all of "the fields the site's pages read"; `units.test.ts`: "the query guard on its own" and "internal field access on its own".
  - Public pages: `pages.test.ts`: "the video grid: only what the public may see, newest first, the same for staff and admins as for a visitor", "another site sees only its own; no site sees nothing", "a creator's page: unlisted, asked out, another site's and missing all get the same answer", "a video's page: hidden, gone, picked-pending, unlisted and missing all get the same answer", "the kind and topic filters, and pages", "a stored website that isn't an http or https link never reaches a page", "a failure is answered in plain words, with no details"; `client/pages.test.tsx`: "nothing is kept in the browser".
  - The sync: `sync.test.ts`: "the rules, through a first sync", "RSS first", "quota", "re-check, gone videos and locks", "the cron"; `units.test.ts`: "the rules", "the feed parser", "the schedule"; `topics.test.ts`.
  - The key and outside calls: `sync.test.ts`: "never reads the key from the environment", "the key never appears in a note, a report or an error", "`enabled` answering ... means no outside call at all, RSS included", "`enabled` throwing is a no"; `units.test.ts`: "errors carry YouTube's message without the key or the URL"; `curation.test.ts`: "a sync problem is told to the site, without the key".
  - Curation: `curation.test.ts`: "two curators at once: exactly one decides", "a member, a signed-out visitor and another site's curator can't decide, and leave no claim"; `security.test.ts`: all of "S2: a claim holds against plain edits"; `staff.test.ts`: all of "the review queue" and "the daily digest"; `units.test.ts`: "a signed-out request holds no queue".
  - Sync now: `staff.test.ts`: all of "Sync now", including "refuses a signed-out visitor, a member, a curator and another site's editor, and starts nothing", "two clicks at once run one sync" and "a creator rests after any sync".
  - Gone videos: `staff.test.ts`: all of "the gone-videos sweep", including "clears nothing without YouTube's answer: no key, outside calls off, or the cap reached"; `sync.test.ts`: "goneVideos "clear" keeps only the site's own notes after the grace period".
  - The player: `client/player.test.tsx`; `client/pages.test.tsx`: "the title as the h1 and the click-to-play player".
- **Gaps added** (`test/transactions.test.ts`, 7 tests, on a made-up Payload whose `find` writes down its arguments, with no database):
  - The fix had no test. The two tests named above failed on the source before c924087 ("the creators find must pass pagination: false: expected undefined to be false", and the same for videos; 2 failed, 5 passed) and pass on the fix (7 passed).
  - "the creator list sends no count; the video grid is the only read that pages": pins `listCreators`, and names the paged lists as the exception the fix left alone.
  - "a new creator is put in its place by name with one find, and no count" and "a creator's mode change re-judges its videos with one find, and no count, in the same transaction": the two hook finds that always run inside a write's transaction. They were right already and nothing held them there. With `pagination: false` taken out of both in the lane, both tests failed; restored, they pass.
  - "a change that leaves the mode alone reads nothing".
  - "every public find is made with the request, as a signed-out visitor, with access checked": the arguments themselves (`user: null`, `overrideAccess: false`) on all five public finds. The page tests prove the outcome; this is small and reads the cause.
- **Gaps skipped (and why):**
  - The race itself (NoSuchTransaction): it needs the find and its count to collide on a real replica set, about 1 run in 7 where it was found. A test that fails by luck is worse than none, so the test reads the arguments.
  - The paged lists inside a transaction (`listVideos`, a creator's videos in `getCreator`, `reviewQueue`): they need the count for their totals and the fix left them as they are, on the grounds that they run outside any transaction. Nothing in the code holds a caller to that, so it's on the lead's list as a question.
  - A source scan for new paginated finds with a request: the shared lint is meant to catch those across the plugins.
  - Payload's own transaction handling, the Mongo adapter and its count query: framework internals, covered by their own projects.
  - The mutation check wasn't rerun: one source file changed since the last run and its two guards were broken by hand above. The three known second-wall survivors stand as recorded.
  - Unchanged from earlier entries: the admin view in a real Payload admin, real browsers and screen readers, YouTube's real answers, and the parity snapshot (2 tests skipped without it).

291 tests in all: 289 run without the parity snapshot, and 2 are skipped. `npm run typecheck` and `npm test` both pass.

## 2026-11-11: before the first public push (after the security read of f81e50a)

| Promise | Tests |
|---|---|
| Sync now's cooldown: a click within 10 minutes of any sync, a person's or the cron's, is a 429 that says when to try again, for editors and admins, and spends nothing; after it, the click runs; someone who may not sync learns nothing | `staff`: Sync now |
| A site's share of the day's units: at its share a site stops with `site-cap` and spends nothing; another site still syncs; the cron goes on past it; the cap and a site's share are told apart | `staff`: Sync now |
| The gone-videos sweep leaves a site at its share for the next run and still sweeps the others | `staff`: the gone-videos sweep |
| The review route answers a signed-out visitor 401, with the same body as Sync now | `staff`: the review queue |
| A stored website that isn't http or https never reaches a page | `pages` |
| The new options are checked | `units`: options |
| Field parity with a site that had the feature built in | `parity`, only with a snapshot given by `WATCHLIST_PARITY_SNAPSHOT` (not in this repo). Without it 2 tests are skipped and say so; run locally with the snapshot, they pass |

**Mutation check (in four copies of the repo in a scratch folder, never the live tree):** the list is now 129 guards:
the 119 before, and 10 new. This round ran the 82 guards in the ten source files that changed (`syncNow`, `ledger`,
`sync`, `gone`, `curation`, `plugin`, `collections`, `server/public`, `server/staff`, `server/result`); the other 47
are in files that didn't change since the full run below, and a dry run found every one of the 129 still in place.
Of the 82: 78 killed on the first run, 4 survived. One was a real gap: "a site past its share is left alone" in the
sweep (with one site in the test, stopping early looked the same). It has a two-site test now and was killed when run
again in a copy. So **79 of 82 killed, 3 survivors**, the same three second walls as before (`reviewVideo`'s own site
check, the "claim is free" filter on a plain edit, and the queue's read with the person's access). All 10 new guards
are killed. With the full run below, that's 126 of 129.

284 tests in all: 282 run without the parity snapshot, and 2 are skipped.

## 2026-11-11: phase 2 (Sync now, the review queue, the digest, the public pages, the gone-videos sweep)

Still on fakes only: Payload 3.92 with an in-memory MongoDB, the made-up YouTube, and the components in jsdom. The
global `fetch` throws in every test. Not tested at all: the admin view, nav link and Sync now field inside a real
Payload admin (they're thin server components around tested parts, and are only type-checked); any page in a real
browser, on a phone, or with a screen reader; and the `/rsc` entry outside a bundler.

| Promise | Tests |
|---|---|
| Sync now is for an editor of the creator's site or an admin: signed out 401, a member and a curator 403, another site's editor the same 404 as a missing creator; a refusal starts nothing | `staff`: Sync now |
| Sync now goes through the unit ledger and the daily cap, and stores nothing new on the creator | `staff`: Sync now; `units`: the admin's view, link and button (a `ui` field); `parity` |
| Two clicks at once run one sync; the other gets a 409 (Local API and REST) | `staff`: Sync now |
| Outside calls off, or a creator who asked out: said in words, no call | `staff`: Sync now |
| The plugin's routes stay first through `overrides` | `units`: overrides |
| The review queue: signed out `signIn`, a member `notStaff`, a curator only their own site, another site's curator never this site's, an admin every site | `staff`: the review queue |
| `reviewQueueCount(payload, { req })`: their sites, every site for an admin, 0 for anyone else and for a site that isn't theirs | `staff`: the review queue |
| The review route: refusals leave the video undecided and unclaimed; a yes shows it; a second curator gets 409 | `staff`: the review queue |
| The queue's buttons are real, named with the title, 44 pixels, one decision at a time; results in a live region, refusals as an alert, the video stays; focus moves to the next video or the heading | `client/admin` |
| The Sync now button: one run however many clicks, the result in a live region, a refusal as an alert | `client/admin` |
| The digest: once a day when videos wait, none when empty, at once only past the threshold, a failed send tried again on the next run, the daily one skipped after the "at once" one; sent after Sync now and the cron | `staff`: the daily digest, Sync now, the cron; `curation` |
| The gone-videos sweep: `keep` does nothing; `clear` clears only videos YouTube still reports gone after the grace period, keeps the ID, choice, kind and topic links, marks returned ones back, and clears nothing without a key, with outside calls off, at the cap, on a quota stop or an error | `staff`: the gone-videos sweep |
| The public server functions read as a signed-out visitor whoever asks: staff, admins and another site's staff get the visitor's answer; no site, nothing | `pages`: the public server functions |
| Unlisted, asked-out, another site's, hidden, gone and picked-pending all answer the same `notFound` as missing | `pages` |
| Only the named filters, checked: a bad kind, topic, slug or video ID is refused; an extra `where` is ignored; topic pages show only automatic and approved videos | `pages` |
| Plain JSON or `{ error: { code, message } }`, with only the public fields, and no detail of a failure | `pages` |
| The fields the site's pages read (the site's team, 2026-11-11) are readable and filterable by a visitor and a member, `videosDefault` and `creator.videosDefault` included; the internal ones still aren't, in `and`/`or`, sorts and through `creator.` | `pages`: the fields the site's pages read; `security`: B1 |
| The pages: one `main` and `h1`, lists, `<time>`, named navs, 44-pixel links, kinds in words, the site's shell, empty state and topic filter, a plain message for a refusal | `client/pages` |
| No iframe until the play button; nothing in web storage or cookies | `client/pages`, `client/player`, `client/admin` |

**Gaps skipped (and why):** the admin view inside Payload's admin and `@payloadcms/next`'s template (needs a running
Next.js app: for the site's team on test at the switch); real focus order and screen-reader speech (jsdom can't; the
markup, names and focus moves are tested); responsive layout (inline CSS grid, checked only as a style string);
Payload's own CSRF and cookie handling on the two routes.

**Mutation check (`scripts/mutate.py`, in five copies of the repo in a scratch folder, never the live tree; each file
restored exactly, checked by hash):** 119 guards, the 62 from phase 1 and 57 new ones for phase 2. The full run killed
115 and left 4. One of the 4 was a real gap and now has a test, so the result is **116 of 119 killed, 3 survivors**.

- "Signed out holds no sites" (`queueSitesOf`) survived the full run: the test providers say no to a request without a
  person, so nothing could tell. It matters when a site's provider says yes without looking at the person. New test:
  `units`, "whose review queue". Run again on its own in a fresh copy: killed.
- Survivor, kept: "the queue is read with the person's access" (`reviewQueue`'s `overrideAccess: false`). A true second
  wall: the list of sites the person holds is already in the query, so the same rows come back either way. It's there
  in case that list is ever wrong.
- Survivor, kept: `reviewVideo`'s own site check (phase 1). The update access refuses anyway.
- Survivor, kept: the "claim is free" filter on a plain edit's claim (phase 1). The owner check and MongoDB's write
  conflict refuse the second curator; it matters only on a database without transactions, which the tests can't run.

All 56 other new guards were killed on the first run.

280 tests in all.

## 2026-11-11: after the security read of 5177185

Each fix had a test that failed first: 43 of the 44 in `test/security.test.ts` failed before the fixes; the one that
passed checks that public filters still work.

| Promise | Tests |
|---|---|
| Internal fields never reach the public: REST and Local API, signed out and as a member, depth 0 and 1 | `security`: B1 |
| Filters and sorts on internal fields refused for the public, in `and`/`or` and through `creator.`; count too | `security`: B1; `units`: the query guard on its own |
| A curator or editor sees internal fields only on their own site's records, and their internal filters stay on their sites | `security`: B1; `units` |
| Field access without a record passes only someone with a role | `units`: internal field access |
| No video points at another site's creator; the public read checks both; re-judging stays in the site | `security`: S1 |
| A claim holds against another curator's plain edit; a plain edit claims atomically; people never write the claim | `security`: S2 |
| Ledger per site; http(s) websites; quota reported as quota; iframe allows autoplay | `security`: nits; `client/player` |

**Mutation check (run in a copy of the repo, never the live tree):** 62 guards, 60 killed. The 18 new ones for these
fixes: 16 killed on the first run after the tests were written, 17 after unit tests for the field access and the query
guard were added. Two survive, both second walls with no test that can tell them apart:
- `reviewVideo`'s own site check (the update access refuses anyway);
- the "claim is free" filter on a plain edit's claim: with it removed, a second curator is still refused, by the owner
  check when the first has committed and by MongoDB's write conflict when both are in flight. It matters only on a
  database without transactions, which the tests can't run.

**Gaps skipped:** none new.

## 2026-11-11: phase 1 (the core, on fakes)

Everything runs on Payload 3.92 with an in-memory MongoDB, a made-up YouTube (`test/fakeYoutube.ts`) and made-up
feeds. The global `fetch` throws in every test (`test/setup.ts`), so nothing reaches the network.

**Promises and the tests that prove them**

| Promise | Tests |
|---|---|
| Only an exact `true` passes; `1`, `'true'`, `{}`, promises of those, throws and `undefined` refuse | `units`: gates fail closed (isAdmin, sitesFor, ofRequest, exactlyTrue) |
| The public reads only shown, not-gone videos of listed, not-do-not-feature creators that aren't picked-pending, on its own site; no site means nothing | `access`: reading (Local API with `overrideAccess: false`, and REST) |
| Member as visitor; curator reviews own site only; staff manage own site only; admin everything | `access`: reading and changing |
| A curator changes only the review fields; nobody moves a record to another site | `access`: changing |
| Overrides can't widen access or remove fields | `access` (an override opening reads), `units`: overrides |
| Shown can't be set around the rules, even by a system write; mode changes, unlisting and do-not-feature apply at once | `access`: changing |
| New creators default to `picked` (the owner, 2026-11-11); a stored creator with no value counts as `picked` | `sync`, `units`: options |
| The rules, in order, and the classifier; unclassified and unreadable answers never show; no hook means nothing shows | `sync`: the rules; `units`: the rules |
| RSS first: nothing new costs no units; a new video costs one details call; a broken feed falls back to the API; no key means feed-only videos for review | `sync`: RSS first |
| The key is never read from env and never appears in a note, report, error or notice | `sync`: gates; `units`: the Data API client; `curation`: a sync problem |
| `enabled` not exactly `true` means no outside call at all, RSS and notices included | `sync`: gates; `curation`: digest |
| The cap is never passed; a quota error stops every creator; retries after 2 and 8 seconds | `sync`: quota |
| Re-check: gone videos marked and hidden, the choice kept, back again later; locked videos kept; changed rules re-judge | `sync`: re-check |
| `goneVideos: 'clear'` keeps only the site's notes after 30 days (the owner, 2026-11-11) | `sync`: re-check |
| Classifier gets titles and descriptions only (the owner, 2026-11-11) | `sync`: the rules |
| Run lock; do-not-feature never synced; the cron syncs only what's due in the site's zone | `sync`: gates, the cron; `units`: the schedule |
| Two curators can't both decide; refusals leave no claim | `curation` |
| Digest: daily once when videos wait, none when empty, urgent once past the threshold | `curation` |
| Topic pages: automatic only where the design says | `topics` |
| Player: no iframe before the click, youtube-nocookie only, a named button, focus moves, link out when not embeddable | `client/player` |
| Images only from YouTube's hosts over https | `units`, `client/player` |
| Field parity with a site that had the feature built in | `parity` (only with a snapshot given by `WATCHLIST_PARITY_SNAPSHOT`, which isn't in this repo; skipped without it) |

**Mutation check:** see the section below.

**Gaps skipped (and why):** Payload's own field validation, the Mongo adapter and React's rendering (covered by
their own projects); the feed's real format and YouTube's real answers (only checkable against YouTube, by the site's team
on test at the switch); podcasts and shows, the review view and the Sync now endpoint (not built yet).

**Mutation check (2026-11-11, `scripts/mutate.py`):** 44 guards broken one at a time, each file restored exactly
(checked by hash). The first run killed 37. Six survivors were real gaps, now covered: the public read's picked-pending,
gone and creator-mode clauses (only reachable when a record is changed outside Payload's hooks: new test), "nothing new
costs nothing" (only visible with a rule playlist: test changed), the ledger's quota stop for a run already going (new
test), and the unclassified guard (rewritten so the check isn't doubled). After that, 43 of 44 killed. The one
survivor, `reviewVideo`'s own site check, is a second wall: without it the curator's update still fails on the
plugin's update access and the claim is let go, so no test can tell them apart. Kept as defense in depth.
