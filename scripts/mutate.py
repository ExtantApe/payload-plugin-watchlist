import hashlib, subprocess, sys, os
# The mutation check: breaks each guard in turn (a string replace), runs the tests that should catch it, and puts the
# file back exactly (checked by hash). "killed" means a test failed, as it should. Usage: python3 scripts/mutate.py [name or prefix such as B1 ...]. Run it in a copy of the repo, never the live tree.
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
A='test/access.test.ts'; S='test/sync.test.ts'; U='test/units.test.ts'; C='test/curation.test.ts'; P='test/client/player.test.tsx'; X='test/security.test.ts'; T='test/staff.test.ts'; G='test/pages.test.ts'; AD='test/client/admin.test.tsx'; PG='test/client/pages.test.tsx'
M=[
 ('exactlyTrue only true','src/access.ts',"return (await check()) === true","return Boolean(await check())",[U,A]),
 ('sitesFor non-array is none','src/access.ts',"return Array.isArray(list) ? list.filter(isSite) : []","return Array.isArray(list) ? list.filter(isSite) : (list as never)",[U]),
 ('ofRequest non-site is null','src/access.ts',"return isSite(site) ? site : null","return site as never",[U]),
 ('public videos: listed creator','src/access.ts',"    { 'creator.listed': { equals: true } },\n","",[A]),
 ('public videos: doNotFeature','src/access.ts',"    { 'creator.doNotFeature': { not_equals: true } },\n","",[A]),
 ('public videos: picked-pending','src/access.ts',"    { or: [{ choice: { equals: 'show' } }, byRules] },\n","",[A]),
 ('public videos: shown','src/access.ts',"    { shown: { equals: true } },\n","",[A]),
 ('public videos: gone','src/access.ts',"    { unavailable: { not_equals: true } },\n","",[A]),
 ('public creators: listed','src/access.ts',"[{ listed: { equals: true } }, ","[",[A]),
 ('no site, no public read','src/access.ts',"if (site === null) return false","if (site === null) return { and: visible }",[A,U]),
 ('creator-level read checks creator mode','src/access.ts',"{ and: [{ curation: { equals: 'rules' } }, { 'creator.videosDefault': { equals: 'rules' } }] }","{ curation: { equals: 'rules' } }",[A,S]),
 ('computeShown: API details only','src/rules.ts'," && v.source === 'api'","",[U,S]),
 ('computeShown: exact rules curation','src/rules.ts',"v.curation === 'rules'","v.curation !== 'picked'",[U]),
 ('computeShown: gone never shows','src/rules.ts',"if (v.unavailable === true) return false","",[U,S]),
 ('Shown always computed','src/collections.ts',"data.shown = computeShown(merged)","data.shown = data.shown ?? computeShown(merged)",[A]),
 ('missing mode is picked','src/collections.ts',"(c?.videosDefault === 'rules' ? 'rules' : 'picked')","(c?.videosDefault === 'picked' ? 'picked' : 'rules')",[S]),
 ('create on own site only','src/collections.ts',"if (!holds(o, editSites, field ? data[field] : null)) throw new Forbidden(req.t)","",[A]),
 ('site never changes','src/collections.ts',"if (field && field in data && !same(data[field], originalDoc?.[field])) throw new Forbidden(req.t)","",[A]),
 ('curator fields only','src/collections.ts',"!allowed.has(k) && !SYSTEM_KEYS.has(k)","false && !SYSTEM_KEYS.has(k)",[A]),
 ('mode change re-judges','src/collections.ts',"if (v.curation !== want) groups.set","if (false) groups.set",[A]),
 ('sync: enabled gate','src/sync.ts',"if (!env.enabled) return","if (false) return",[S]),
 ('sync: enabled exactly true','src/sync.ts',"const enabled = await exactlyTrue(() => o.enabled(req))","const enabled = Boolean(await o.enabled(req))",[S]),
 ('sync: never env key','src/sync.ts',"key = typeof k === 'string' && k.trim() ? k.trim() : null","key = typeof k === 'string' && k.trim() ? k.trim() : (process.env.YT_DATA_API_KEY ?? null)",[S]),
 ('sync: doNotFeature skip','src/sync.ts',"if (creator.doNotFeature === true) return","if (false) return",[S]),
 ('sync: nothing new costs nothing','src/sync.ts',"if (feed && !feedNew!.length && !extra) {","if (false) {",[S]),
 ('sync: run lock','src/sync.ts',"{ _id: id, $or: [{ syncingSince: null }, { syncingSince: { $exists: false } }, { syncingSince: { $lt: stale } }] }","{ _id: id }",[S,T]),
 ('sync: retries back off','src/sync.ts',"attempt < RETRY_WAITS_MS.length","attempt < 0",[S]),
 ('sync: classifier gets title and description only','src/sync.ts',"({ key: v.id, title: v.title, description: v.description.slice(0, o.descriptionChars), channel: ch.title ?? ch.handle })","({ key: v.id, title: v.title, description: v.description.slice(0, o.descriptionChars), channel: ch.title ?? ch.handle, duration: v.duration })",[S]),
 ('sync: unclassified never passes','src/sync.ts',"const relevant = Boolean(valid) && c!.relevant !== false","const relevant = c?.relevant !== false",[S]),
 ('ledger: cap','src/ledger.ts',"units: { $lte: o.dailyUnitCap - units }","units: { $lte: 1e12 }",[S]),
 ('ledger: quota stop','src/ledger.ts',"quotaStopped: { $ne: true }, ","",[S]),
 ('ledger: digest once a day','src/ledger.ts',"const r = await native().updateOne({ day, ...free }, { $set: { [path]: now(), updatedAt: now() } })","const r = await native().updateOne({ day }, { $set: { [path]: now(), updatedAt: now() } })",[C,T]),
 ('youtube: key scrubbed','src/youtube.ts',"if (key) out = out.split(key).join('[key]')","",[U,S]),
 ('youtube: embeddable only on true','src/youtube.ts',"embeddable: v.status?.embeddable === true","embeddable: v.status?.embeddable !== false",[U]),
 ('images: YouTube hosts only','src/ids.ts',"YOUTUBE_IMAGE_HOSTS.includes(u.host)","true",[U,P]),
 ('review: atomic claim','src/curation.ts',"{ _id: id, $and: free }","{ _id: id }",[C]),
 ('review: curator of the site','src/curation.ts',"if (!admin && !holds(o, await curateSites(o, req), o.scope.field ? video[o.scope.field] : null)) throw new Forbidden(req.t)","",[C]),
 ('digest: only when enabled','src/curation.ts',"if (due && enabled && o.notify","if (due && o.notify",[C]),
 ('overrides: access only narrowed','src/protect.ts',"access[op] = !given || seen.has(given) ? fn : narrow(fn, given)","access[op] = !given || seen.has(given) ? fn : given",[U,A]),
 ('overrides: fields kept','src/protect.ts',"if (!now) throw new Error(`Watchlist: overrides.${slug} removed the field","if (!now) continue; if (false) throw new Error(`Watchlist: overrides.${slug} removed the field",[U]),
 ('player: nocookie host','src/client/Player.tsx',"const NOCOOKIE = 'https://www.youtube-nocookie.com/embed/'","const NOCOOKIE = 'https://www.youtube.com/embed/'",[P]),
 ('player: click to play','src/client/Player.tsx',"useState(!loadOnClick)","useState(true)",[P]),
 ('player: link out when not embeddable','src/client/Player.tsx',"if (embeddable === false)","if (false)",[P]),
 ('player: bad ID renders nothing','src/client/Player.tsx',"if (!isVideoId(youtubeId)) return null","",[P]),
 ('B1: internal field read needs the record\'s site','src/access.ts',"    return holds(o, sites, o.scope.field ? (doc as Record<string, unknown>)[o.scope.field] : null)\n  }\n}","    return true\n  }\n}",[X,U]),
 ('B1: no role, no internal field even without a record','src/access.ts',"if (!doc) return sites.length > 0","if (!doc) return true",[X,U]),
 ('B1: query guard refuses the public','src/access.ts',"if (!sites.length) throw new Forbidden(req.t)","if (!sites.length) return args",[X,U]),
 ('B1: query guard keeps staff to their sites','src/access.ts',"    if (o.scope.field) a.where = a.where && Object.keys(a.where).length ?","    if (false) a.where = a.where && Object.keys(a.where).length ?",[X,U]),
 ('B1: guard looks inside and/or','src/access.ts',"if (k === 'and' || k === 'or') pathsOf(v, out)","if (k === 'and' || k === 'or') continue",[X,U]),
 ('B1: guard follows creator.','src/access.ts',"      if (fields.some((f) => rest === f || rest.startsWith(`${f}.`))) return true","",[X,U]),
 ('B1: guard covers sort','src/access.ts',"const used = [...pathsOf(a.where), ...sorts,","const used = [...pathsOf(a.where),",[X,U]),
 ('S1: same-site creator on write','src/collections.ts',"if (!creator || site === null || idOf(creator[field]) !== site) throw new CrossSite()","if (!creator) throw new CrossSite()",[X]),
 ('S1: public read checks the creator\'s site','src/access.ts',"return { and: [...visible, { [o.scope.field]: { equals: site } }, ...creatorSite] }","return { and: [...visible, { [o.scope.field]: { equals: site } }] }",[X]),
 ('S1: re-judge within the site','src/collections.ts',"const where: Where = field ? { and: [{ creator: { equals: doc.id } }, { [field]: { equals: idOf(doc[field]) } }] } : { creator: { equals: doc.id } }","const where: Where = { creator: { equals: doc.id } }",[X]),
 ('S2: another curator\'s claim holds','src/collections.ts',"if (owner && owner !== me) throw new AlreadyDecided()","",[X]),
 ('S2: plain edit claims atomically','src/collections.ts',"won = await model.updateOne({ _id: originalDoc.id, $or: [{ claim: null }, { claim: { $exists: false } }] }, { $set: { claim: token } }","won = await model.updateOne({ _id: originalDoc.id }, { $set: { claim: token } }",[X]),
 ('S2: people never write the claim','src/collections.ts',"    data.claim = originalDoc?.claim ?? null\n","",[X,C]),
 ('nit: ledger shows own sites only','src/collections.ts',".filter(([k]) => mine.has(k))","",[X]),
 ('nit: ledger total is admin-only','src/collections.ts',"staffField(o, 'admin'), ['units', 'digests']","staffField(o), ['digests']",[X]),
 ('nit: website http(s) only','src/collections.ts',"validate: httpOnly, ","",[X]),
 ('nit: quota reported as quota','src/ledger.ts',"      if (doc?.quotaStopped === true) return 'quota'\n","",[X,S]),
 ('nit: iframe allows autoplay','src/client/Player.tsx',"accelerometer; autoplay; encrypted-media","accelerometer; encrypted-media",[P]),
 # ---- phase 2
 ('phase 2: sync now: signed out is refused','src/syncNow.ts',"  if (!req?.user) throw refuse('Sign in first.', 401)\n","",[T]),
 ('phase 2: sync now: editors only','src/syncNow.ts',"  if (!admin && !sites.length) throw refuse('Sync now is for the site’s editors.', 403)\n","",[T]),
 ('phase 2: sync now: the creator\'s own site','src/syncNow.ts',"(!admin && !holds(o, sites, o.scope.field ? creator[o.scope.field] : null))","false",[T]),
 ('phase 2: sync now: a second run is a 409','src/syncNow.ts',"  if (report.skipped === 'busy') throw refuse('This creator is syncing already. Try again in a few minutes.', 409)\n","",[T]),
 ('phase 2: sync now: off means off','src/syncNow.ts',"  if (report.skipped === 'disabled') throw refuse('Syncing is off here: outside connections aren’t allowed.', 400)\n","",[T]),
 ('phase 2: sync now: asked out is said','src/syncNow.ts',"  if (report.skipped === 'do-not-feature') throw","  if (false) throw",[T]),
 ('phase 2: sync now: urgent digest after','src/syncNow.ts',"if (report.added > 0) await sendReviewDigest","if (false) await sendReviewDigest",[T]),
 ('phase 2: cron: urgent digest after','src/sync.ts',"  if (grew.length) {","  if (false) {",[T]),
 ('phase 2: overrides: routes kept first','src/protect.ts',"const endpoints = [...mine, ...(Array.isArray(out.endpoints) ? out.endpoints.filter((e) => !mine.includes(e)) : [])]","const endpoints = [...(Array.isArray(out.endpoints) ? out.endpoints.filter((e) => !mine.includes(e)) : []), ...mine]",[U]),
 ('phase 2: overrides: routes kept at all','src/protect.ts',"const endpoints = [...mine, ...(Array.isArray(out.endpoints) ? out.endpoints.filter((e) => !mine.includes(e)) : [])]","const endpoints = Array.isArray(out.endpoints) ? out.endpoints : []",[U]),
 ('phase 2: queue: signed out is told to sign in','src/server/staff.ts',"    if (!req.user) throw new PageError('signIn')\n","",[T]),
 ('phase 2: queue: no role, no queue','src/server/staff.ts',"    if (!who) throw new PageError('notStaff')\n","    if (!who) return { rows: [], total: 0, page: 1, pages: 1 }\n",[T]),
 ('phase 2: queue: signed out holds no sites','src/curation.ts',"  if (!req?.user) return null\n","",[T,U]),
 ('phase 2: queue: no sites is nobody','src/curation.ts',"  if (!mine.length) return null\n","",[T]),
 ('phase 2: queue: only a site they hold','src/curation.ts',"return holds(o, mine, site) ? { sites: [site] } : null","return { sites: [site] }",[T]),
 ('phase 2: queue: kept to the person\'s sites','src/curation.ts',"if (o.scope.field && sites !== null) and.push(","if (false) and.push(",[T,C]),
 ('phase 2: queue: read with the person\'s access','src/server/staff.ts',"      overrideAccess: false,\n      user: req.user,","      overrideAccess: true,\n      user: req.user,",[T]),
 ('phase 2: queue: count is 0 without a role','src/curation.ts',"  if (!who) return 0\n","  if (!who) return countWaiting(payload, args?.site ?? null)\n",[T]),
 ('phase 2: digest: a failed send gives the claim back','src/curation.ts',"        await book.releaseDigest(site, opts.mode)\n","",[T]),
 ('phase 2: digest: daily stands down after urgent','src/ledger.ts',"const free = kind === 'daily' ?","const free = false ?",[T]),
 ('phase 2: digest: nothing when empty','src/curation.ts',"opts.mode === 'daily' ? waiting > 0 :","opts.mode === 'daily' ? waiting >= 0 :",[T,C]),
 ('phase 2: digest: at once only past the threshold','src/curation.ts',": waiting > o.urgentAt",": waiting > 0",[T]),
 ('phase 2: gone: keep does nothing','src/gone.ts',"if (o.goneMode !== 'clear') return","if (false) return",[T]),
 ('phase 2: gone: off means off','src/gone.ts',"if (!env.enabled) return","if (false) return",[T]),
 ('phase 2: gone: no key, no clearing','src/gone.ts',"  if (!env.key) return { ...report, skipped: 'no-key' }\n  const api = dataApi(env.key, env.fetcher)","  const api = dataApi(env.key ?? '', env.fetcher)",[T]),
 ('phase 2: gone: units reserved first','src/gone.ts',"    if (reserved !== 'ok') return { ...report, stopped: reserved }\n","",[T]),
 ('phase 3: gone: a site past its share is left alone','src/gone.ts',"      report.stopped = 'site-cap'\n      continue\n","      report.stopped = 'site-cap'\n",[T]),
 ('phase 2: gone: the grace period','src/gone.ts',"{ unavailableSince: { less_than_equal: before } }, ","",[T]),
 ('phase 2: gone: only what YouTube still reports gone','src/gone.ts',"      if (live.has(v.youtubeId)) {","      if (false) {",[T]),
 ('phase 2: gone: a quota error stops the day','src/gone.ts',"        await env.ledger.stopForQuota()\n","",[T]),
 ('phase 2: gone: an error clears nothing','src/gone.ts',"      return { ...report, stopped: 'error' }","      live = new Set()",[T]),
 ('phase 2: pages: read as a visitor','src/server/public.ts',"url: req.url, user: null }","url: req.url, user: req.user }",[G]),
 ('phase 2: pages: videos through access','src/server/public.ts',"    depth: 1,\n    overrideAccess: false,\n    req: visitor,\n    select: videoSelect(o) as never,","    depth: 1,\n    overrideAccess: true,\n    req: visitor,\n    select: videoSelect(o) as never,",[G]),
 ('phase 2: pages: creators through access','src/server/public.ts',"sort: '_order', pagination: false, depth: 0, overrideAccess: false,","sort: '_order', pagination: false, depth: 0, overrideAccess: true,",[G]),
 ('phase 2: pages: one creator through access','src/server/public.ts',"where: { slug: { equals: input.slug } }, limit: 1, depth: 0, overrideAccess: false,","where: { slug: { equals: input.slug } }, limit: 1, depth: 0, overrideAccess: true,",[G]),
 ('phase 2: pages: one video through access','src/server/public.ts',"      limit: 1,\n      depth: 1,\n      overrideAccess: false,","      limit: 1,\n      depth: 1,\n      overrideAccess: true,",[G]),
 ('phase 2: pages: kind checked','src/server/public.ts',"    if (input.kind !== undefined && input.kind !== null && input.kind !== '' && !kind) throw new PageError('badInput')\n","",[G]),
 ('phase 2: pages: topic checked','src/server/public.ts'," || !/^[\\w-]{1,64}$/.test(String(input.topic))","",[G]),
 ('phase 2: pages: topic pages need a yes','src/server/public.ts',", { [t.state]: { in: ['auto', 'approved'] } })",")",[G]),
 ('phase 2: pages: video id checked','src/server/public.ts',"    if (!isVideoId(input?.youtubeId)) throw new PageError('notFound')\n","",[G]),
 ('phase 2: pages: slug checked','src/server/public.ts',"    if (typeof input?.slug !== 'string' || !input.slug || input.slug.length > 120) throw new PageError('notFound')\n","",[G]),
 ('phase 2: pages: failures carry no details','src/server/result.ts',"    return { error: { code: 'generic', message: MESSAGES.generic } }\n  }\n}","    return { error: { code: 'generic', message: String((error as Error).message) } }\n  }\n}",[G]),
 ('phase 2: fields: channel uploads stay hidden','src/collections.ts',"'minMinutes', 'uploads', ","'minMinutes', ",[G,X]),
 ('phase 2: fields: channel keywords stay hidden','src/collections.ts',"export const INTERNAL_CHANNEL_FIELDS = ['excludeKeywords', ","export const INTERNAL_CHANNEL_FIELDS = [",[G,X]),
 ('phase 2: fields: the schedule stays hidden','src/collections.ts',"'syncDays', 'syncHour', ","'syncDays', ",[G,X]),
 ('phase 2: review ui: one decision at a time','src/client/ReviewQueue.tsx',"    if (running.current) return\n","",[AD]),
 ('phase 2: review ui: buttons named with the title','src/client/ReviewQueue.tsx'," aria-label={`${showText}: ${row.title}`}","",[AD]),
 ('phase 2: review ui: live region','src/client/ReviewQueue.tsx','<p role="status" aria-live="polite" data-watchlist-status>','<p data-watchlist-status>',[AD]),
 ('phase 2: review ui: a refusal keeps the video','src/client/ReviewQueue.tsx',"      if (!res.ok) {","      if (false) {",[AD]),
 ('phase 2: review ui: a refusal is an alert','src/client/ReviewQueue.tsx','<p role="alert" data-watchlist-problem>','<p data-watchlist-problem>',[AD]),
 ('phase 2: review ui: focus moves on','src/client/ReviewQueue.tsx',"      setFocusOn(left.length ? (left[Math.min(at, left.length - 1)]!.id) : 'heading')\n","",[AD]),
 ('phase 2: sync button: one run at a time','src/client/SyncNowButton.tsx',"    if (running.current) return\n","",[AD]),
 ('phase 2: sync button: a refusal is an alert','src/client/SyncNowButton.tsx',"if (!res.ok) setSaid({ kind: 'error',","if (false) setSaid({ kind: 'error',",[AD]),
 ('phase 2: ui: 44px buttons','src/ui.ts',"export const TARGET: CSSProperties = { minHeight: 44, minWidth: 44,","export const TARGET: CSSProperties = { minHeight: 24, minWidth: 24,",[AD]),
 ('phase 2: ui: 44px links','src/ui.ts',"export const LINK_TARGET: CSSProperties = { display: 'inline-flex', alignItems: 'center', minHeight: 44, minWidth: 44,","export const LINK_TARGET: CSSProperties = { display: 'inline-flex', alignItems: 'center', minHeight: 24, minWidth: 24,",[PG]),
 ('phase 2: pages ui: a problem is an alert','src/pages/slots.tsx','<div role="alert" className="wl-problem">','<div className="wl-problem">',[PG]),
 ('phase 2: pages ui: an error draws no page','src/pages/pages.tsx',"  if (isError(result))\n","  if (false)\n",[PG]),
 ('phase 2: pages ui: the kind is said in words','src/pages/pages.tsx',"{v.kindLabel ? <Badge>{v.kindLabel}</Badge> : null}\n            </p>\n          </article>\n        </li>","</p>\n          </article>\n        </li>",[PG]),
 # ---- before the first public push
 ('phase 3: sync now: the cooldown','src/syncNow.ts',"  if (wait > 0) throw refuse(","  if (false) throw refuse(",[T]),
 ('phase 3: sync now: the cooldown is the option\'s length','src/syncNow.ts',"last + o.syncNowCooldownMs - now.getTime()","last + 1000 - now.getTime()",[T]),
 ('phase 3: ledger: a site\'s share','src/ledger.ts',"const share = o.siteDailyUnitCap === null ? {} :","const share = true ? {} :",[T]),
 ('phase 3: ledger: the cap is told from a site\'s share','src/ledger.ts',"      if (Number(doc?.units ?? 0) > o.dailyUnitCap - units) return 'cap'\n","",[T]),
 ('phase 3: cron: a site past its share stops only itself','src/sync.ts',"if (r.stopped === 'cap' || r.stopped === 'quota') out.stopped = r.stopped","if (r.stopped) out.stopped = r.stopped as never",[T]),
 ('phase 3: review route: signed out is a 401','src/curation.ts',"  if (!req?.user) throw new APIError('Sign in first.', 401, undefined, true)\n","",[T]),
 ('phase 3: pages: a stored website must be http(s)','src/server/public.ts',"return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null\n  } catch {\n    return null\n  }\n}\n\nfunction creatorCard","return u.toString()\n  } catch {\n    return null\n  }\n}\n\nfunction creatorCard",[G]),
 ('phase 3: options: the cooldown is checked','src/plugin.ts',"  if (!(Number.isInteger(cooldown) && cooldown >= 0)) fail(","  if (false) fail(",[U]),
 ('phase 3: options: the site share is checked','src/plugin.ts',"  if (siteCap !== null && !(Number.isInteger(siteCap) && siteCap > 0 && siteCap <= cap)) fail(","  if (false) fail(",[U]),
]
only=sys.argv[1:]
# MUTATE_SHARD=2/4 runs every fourth guard starting at the second, so several copies of the repo can share the work.
shard,shards=[int(x) for x in os.environ.get('MUTATE_SHARD','1/1').split('/')]
res=[]
for n,(name,f,old,new,tests) in enumerate(M):
    if n % shards != shard-1: continue
    if only and not any(name == x or name.startswith(x + ':') for x in only): continue
    # MUTATE_FILES=src/a.ts,src/b.ts keeps to guards in those files; MUTATE_DRY=1 only checks every guard is still found.
    if os.environ.get('MUTATE_FILES') and f not in os.environ['MUTATE_FILES'].split(','): continue
    if os.environ.get('MUTATE_DRY'):
        c=open(os.path.join(ROOT,f)).read().count(old); res.append((name,'killed' if c==1 else 'NOT-FOUND')); print(name,'found' if c==1 else 'NOT-FOUND(%d)'%c,flush=True); continue
    path=os.path.join(ROOT,f); orig=open(path,'rb').read(); h=hashlib.sha256(orig).hexdigest()
    s=orig.decode()
    if s.count(old)!=1: res.append((name,'NOT-FOUND(%d)'%s.count(old))); print(name,'NOT-FOUND',flush=True); continue
    open(path,'w').write(s.replace(old,new))
    try:
        r=subprocess.run(['npx','vitest','run',*tests],cwd=ROOT,capture_output=True,text=True,timeout=900)
        out='killed' if r.returncode!=0 else 'SURVIVED'
    finally:
        open(path,'wb').write(orig)
        assert hashlib.sha256(open(path,'rb').read()).hexdigest()==h
    res.append((name,out)); print(name,out,flush=True)
print('---'); print(sum(1 for _,o in res if o=='killed'),'/',len(res),'killed')
