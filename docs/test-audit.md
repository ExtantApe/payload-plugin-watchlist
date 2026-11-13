# Test audit

Kept by this repo's owning session. Newest first.

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
| The fields the site's pages read (Site lead, 2026-11-11) are readable and filterable by a visitor and a member, `videosDefault` and `creator.videosDefault` included; the internal ones still aren't, in `and`/`or`, sorts and through `creator.` | `pages`: the fields the site's pages read; `security`: B1 |
| The pages: one `main` and `h1`, lists, `<time>`, named navs, 44-pixel links, kinds in words, the site's shell, empty state and topic filter, a plain message for a refusal | `client/pages` |
| No iframe until the play button; nothing in web storage or cookies | `client/pages`, `client/player`, `client/admin` |

**Gaps skipped (and why):** the admin view inside Payload's admin and `@payloadcms/next`'s template (needs a running
Next.js app: for the Site lead on test at the switch); real focus order and screen-reader speech (jsdom can't; the
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
their own projects); the feed's real format and YouTube's real answers (only checkable against YouTube, by the Site lead
on test at the switch); podcasts and shows, the review view and the Sync now endpoint (not built yet).

**Mutation check (2026-11-11, `scripts/mutate.py`):** 44 guards broken one at a time, each file restored exactly
(checked by hash). The first run killed 37. Six survivors were real gaps, now covered: the public read's picked-pending,
gone and creator-mode clauses (only reachable when a record is changed outside Payload's hooks: new test), "nothing new
costs nothing" (only visible with a rule playlist: test changed), the ledger's quota stop for a run already going (new
test), and the unclassified guard (rewritten so the check isn't doubled). After that, 43 of 44 killed. The one
survivor, `reviewVideo`'s own site check, is a second wall: without it the curator's update still fails on the
plugin's update access and the claim is let go, so no test can tell them apart. Kept as defense in depth.
