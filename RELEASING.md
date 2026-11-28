# Releasing

`package.json` (`description`, `keywords`) is the single source for the description. Copy it to GitHub with `gh repo edit --description`, and keep the repo's topics in line with `keywords`. The Release workflow refuses to stage if GitHub's description differs.

## The first version under this name, 0.3.0

npm can only trust a workflow for a package that exists, so the owner publishes this one by hand. Build and test first:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Then publish, on its own line:

```sh
npm publish --ignore-scripts --access public
```

Then set up trusted publishing:

```sh
npm trust github @extantape/payload-plugin-playlists --repo ExtantApe/payload-plugin-playlists --file release.yml --allow-stage-publish --yes
```

Pushing the tag `v0.3.0` afterwards makes one Release run fail at the stage step, because that version already exists. Leave it.

## Later versions

1. Bump `version` in `package.json`, set GitHub's description with `gh repo edit --description` to match `package.json`, commit as `Release x.y.z`, tag `vx.y.z`, and push the commit and the tag.
2. The Release workflow tests, builds and **stages** the version on npm (trusted publishing, no stored token).
3. The npm account that owns the `extantape` org approves it with 2FA: npmjs.com → avatar → **Staged Packages** → **Approve**, or `npm stage list` then `npm stage approve <id>`. Only then is it public.

Sessions never publish, deprecate or approve.
