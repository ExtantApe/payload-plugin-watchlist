# Changelog

## Unreleased

- Tests for the transaction fix (`test/transactions.test.ts`): the creator and video lookups, the creator list and the two hooks that read inside a write pass `pagination: false`, and every public find is made as a signed-out visitor with access checked. Tested: typecheck and the full suite (289 run, 2 skipped without the parity snapshot); the two tests for the fix failed on the source before it. Not tested: the race itself, which needs a real replica set and luck, and the paged lists inside a transaction.

## 0.1.0 (2026-11-11)

Phases 1 and 2, on fakes. Not on npm; no site uses it.

- `creators`, `videos` and `watchlist-usage`, with the site's slugs and field names, and the plugin's rules kept through `overrides`.
- Access that passes only an exact `true`: the public reads shown videos of listed creators that aren't picked-pending; curators review their site; editors manage it.
- RSS first, then the Data API with a key the site passes in; a daily unit cap, a quota stop and retries after 2 and 8 seconds.
- The per-channel rules, the classifier hook (titles and descriptions only), topic pages, the weekly re-check, the monthly full read and the run lock.
- `syncDue` for the site's cron, `syncCreator`, `reviewVideo` with an atomic claim, `reviewQueueCount` and `sendReviewDigest`.
- `Player`: click to play, youtube-nocookie, a link out when embedding is off.
- Security read fixes: internal fields hidden from the public and refused in filters and sorts; videos and creators on the same site; a curator's claim holds against plain edits; per-site unit ledger; http and https websites only.
- Sync now: `syncNow` and `POST /api/creators/:id/sync` for a site's editors, with a button on each creator, through the same unit ledger, daily cap and run lock.
- The curator's review queue: `reviewQueue`, the `ReviewQueue` component, an admin view with a nav link and count, and `POST /api/videos/:id/review`.
- `reviewQueueCount(payload, { req, site? })` counts only what the person may review. It replaces `reviewQueueCount(payload, site)`.
- The digest retries a failed send on the next run, and the daily one is skipped on a day the "at once" one went. `syncDue` and Sync now send the "at once" digest themselves.
- Public pages: `listCreators`, `getCreator`, `listVideos` and `getVideo` from `/server`, and `CreatorListPage`, `CreatorPage`, `VideosPage`, `VideoGrid` and `VideoPage` from `/pages`, with the site's shell, empty state and topic filter as slots.
- `sweepGoneVideos` for the site's cron: with `goneVideos.mode: 'clear'`, clears the stored details of videos YouTube still reports gone, inside the unit cap.
- A creator's `videosDefault` and each channel's `playlists` are publicly readable and filterable, because the site's pages read them.
- The plugin's routes stay through `overrides`.
- Sync now rests a creator for `syncNow.cooldownMinutes` (10) after any sync and answers 429 with when to try again. `youtube.siteDailyUnitCap` gives each site its own share of the day's units.
- The review route answers a signed-out visitor 401.
- The parity test reads its snapshot from `WATCHLIST_PARITY_SNAPSHOT` and is skipped without it.
