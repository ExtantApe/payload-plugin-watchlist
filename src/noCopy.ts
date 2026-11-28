import { APIError, type CollectionBeforeChangeHook, type CollectionBeforeOperationHook, type Payload } from 'payload'

import { shapeGuard, shapeGuardChange } from './shape.js'

/**
 * The plugin's records are never duplicated, by anyone, server code included. Every duplicate (REST, GraphQL,
 * `payload.duplicate` and `payload.create` with `duplicateFromID`) is a create that carries `duplicateFromID`. The answer
 * is the same for every id. Any value there is refused, an empty one included.
 */
export const noCopy: CollectionBeforeOperationHook = ({ args, operation }) => {
  const from = (args as { duplicateFromID?: unknown }).duplicateFromID
  if (operation === 'create' && from !== undefined && from !== null) throw new APIError('Watchlist records can’t be duplicated. Make a new one instead.', 403, undefined, true)
}

/**
 * Puts the rule back once the whole config is built: `disableDuplicate` is on, and the refusal runs before and after
 * every other `beforeOperation` hook, so one added later that sets `duplicateFromID` is refused too.
 */
export function keepNoCopy(payload: Payload, slugs: string[]): void {
  for (const slug of slugs) {
    const config = (payload.collections as Record<string, { config: { disableDuplicate?: boolean; hooks: { beforeOperation?: CollectionBeforeOperationHook[] } } } | undefined>)[slug]?.config
    if (!config) continue
    config.disableDuplicate = true
    config.hooks.beforeOperation = [noCopy, ...(config.hooks.beforeOperation ?? []).filter((h) => h !== noCopy), noCopy]
  }
}

/**
 * Puts the shape check back the same way: before and after every other `beforeOperation` hook, and last in
 * `beforeChange`, so what a hook added later puts into the data is checked too. Called before `keepNoCopy`, which
 * leaves its own rule outermost.
 */
export function keepShape(payload: Payload, slugs: string[]): void {
  for (const slug of slugs) {
    const config = (payload.collections as Record<string, { config: { hooks: { beforeOperation?: CollectionBeforeOperationHook[]; beforeChange?: CollectionBeforeChangeHook[] } } } | undefined>)[slug]?.config
    if (!config) continue
    config.hooks.beforeOperation = [shapeGuard, ...(config.hooks.beforeOperation ?? []).filter((h) => h !== shapeGuard), shapeGuard]
    config.hooks.beforeChange = [...(config.hooks.beforeChange ?? []).filter((h) => h !== shapeGuardChange), shapeGuardChange]
  }
}
