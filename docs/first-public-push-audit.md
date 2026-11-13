# First public push audit

Prepared with phase 2 and run again on 2026-11-11 after the security read's changes, for the Plugins Lead's review before the repo's first push (the owner agreed on 2026-11-11 to make it public at its first release). The first push is one fresh commit of the final tree, version 0.1.0, with `"private"` removed.

| Check | Result |
| --- | --- |
| `scripts/leak-check.sh`, with the private terms and in CI mode | passed in both modes on the final tree, with every change staged |
| Keys, tokens, secrets | none. The only key-like strings are made-up test values (`made-up-key…`, `test-secret-not-for-production`). The plugin never reads `process.env`; the one test that sets an env variable sets a made-up value to prove it's ignored |
| Server addresses | none. URLs in the tree are YouTube's and Google's public hosts, `example.com`, the reserved `.example` and `.test`, `localhost` in the test harness, GitHub and the npm registry |
| Email addresses in the tree | none but `@example.test` test people |
| Email addresses in history | only the noreply author address; no repo-level `user.email` |
| Personal names | none in code, docs, tests or commit messages. The git author field carries the owner's name, which the owner allows |
| Player or visitor data | none. Tests use made-up people, sites, channels, videos and topics |
| Build output, `node_modules`, `.env`, `.secrets/` | never committed; `dist/` and `node_modules/` are ignored |
| Leak check in CI | yes, `.github/workflows/leak-check.yml`, on every push and pull request |
| LICENSE | MIT, "Copyright (c) 2026 Captive Origins" |
| The private site's details | none in the tree: no file paths, branch names, commit ids, env names or function names of the site, and nothing about its API. Checked with a list of those names against every tracked file |
| Keywords | base words, `media`, `integrations`, `multi-tenant`, then function words; no family tags |

## Removed before the push (2026-11-11, after the security read)

- From the design record: the table of the site's files, its branch and commit, its env and function names, its test files and counts, its data counts, and the note about its API. The record now describes the plugin, and says only that it was moved out of a site that had the feature built in.
- From the decisions, README, test audit, comments and tests: the same kinds of names, the internal item numbers of the owner's answers, and quotes from private chat. The owner's decisions themselves stay, dated.
- From the tree: the snapshot of that site's fields (`test/fixtures/site-fields.json`) and the script that read its source (`scripts/site-fields.mjs`). The parity test now takes a snapshot from the path in `WATCHLIST_PARITY_SNAPSHOT` and is skipped without it. Neither file is in the published history: see below.

## For the reviewer to decide before the push

- **History.** The removed text and the two removed files were in earlier local commits. Those were never pushed: the public history starts from one fresh commit of the final tree.
- **The starter kit's files.** `CLAUDE.md` names the private ops process and paths under the owner's home folder, and `.github/workflows/release.yml` and `RELEASING.md` name the platform repo's `packages:sync` script. Every plugin made from the starter kit carries the same files, public ones included, so they were left as they are.
- **Field names.** The topic fields default to `species`, `speciesState`, `speciesNames`, `speciesMode` and `speciesTitles`, and the tests use `tenant` and `taxa`. These are the plugin's own defaults and test names now, so they stay.
- **Roles in the docs.** "Site lead" and "Plugins Lead" appear in the decisions as who answered. No person is named.
