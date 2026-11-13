/**
 * The public pages, as server components (no hooks): each takes its server function's answer (from `/server`) and the
 * site's slots, and draws the page with the click-to-play player inside. Mount them from thin routes in your site.
 */
export { Badge, CreatorListPage, CreatorPage, Pages, TEXT, VideoGrid, VideoPage, VideosPage, type PageSlots, type PageText, type WatchPaths } from './pages.js'
export { DefaultEmpty, DefaultShell, PageProblem, type EmptyProps, type EmptySlot, type ShellProps, type ShellSlot, type TopicFilterProps, type TopicFilterSlot } from './slots.js'
export { clock, clockWords, day, LINK_TARGET, TARGET } from '../ui.js'
