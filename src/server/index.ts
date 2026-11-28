/**
 * Server functions for the Playlists pages. Each is a plain async function `(req, input)` that checks access itself
 * and answers plain JSON, or `{ error: { code, message } }`. Mount them in your own thin routes or server actions.
 */
export { isError, MESSAGES, PageError, plain, serve, type Result, type WatchError } from './result.js'
export { getCreator, getVideo, listCreators, listVideos, PAGE_SIZE, visitorOf, type CreatorCard, type CreatorListData, type CreatorPageData, type VideoCard, type VideoList, type VideoPageData, type VideosData } from './public.js'
export { QUEUE_PAGE_SIZE, reviewQueue, type QueueRow, type ReviewQueueData } from './staff.js'
