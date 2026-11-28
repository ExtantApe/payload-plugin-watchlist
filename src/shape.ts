import { APIError, type CollectionBeforeChangeHook, type CollectionBeforeOperationHook, type Field } from 'payload'

import { topLevelFields } from './protect.js'

/** The one answer for every refusal. It never repeats a key or a value from the write. */
export const BAD_SHAPE = 'Watchlist couldn’t save this: the data isn’t in the shape of the collection’s fields.'

type Obj = Record<string, unknown>
type BlockLike = { slug: string; fields: Field[] }
type Blocks = Record<string, unknown> | undefined
/** A field that can hold others: a group, a named tab, an array or a blocks field. */
type Holder = { name: string; type?: string; localized?: boolean; fields?: Field[]; blocks?: BlockLike[]; blockReferences?: (BlockLike | string)[] }

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const refuse = (): never => {
  throw new APIError(BAD_SHAPE, 400, undefined, true)
}

function checkKeys(data: Obj): void {
  for (const k of Object.keys(data)) {
    if (k.startsWith('$')) refuse()
    if (k.includes('.')) refuse()
  }
}

function checkLevel(data: Obj, fields: Field[], blocks: Blocks): void {
  checkKeys(data)
  for (const f of topLevelFields<Holder>(fields)) {
    if (Object.hasOwn(data, f.name)) checkField(data[f.name], f, blocks, Boolean(f.localized))
  }
}

/** Json, rich text, point and every other single value is left alone: it's stored as it is. */
function checkField(value: unknown, f: Holder, blocks: Blocks, localized: boolean): void {
  const list = f.type === 'array' || f.type === 'blocks'
  if (!list && !f.fields) return
  // Every locale at once: an object keyed by locale, with none of the field's own names in it.
  const names = new Set(topLevelFields<Holder>(f.fields ?? []).map((x) => x.name))
  if (localized && isObject(value) && !Object.keys(value).some((k) => names.has(k))) {
    checkKeys(value)
    for (const one of Object.values(value)) checkField(one, f, blocks, false)
    return
  }
  if (!list) {
    if (isObject(value)) checkLevel(value, f.fields!, blocks)
    return
  }
  // Payload turns 0 or '0' into an empty list after this guard runs; the admin form sends an empty list that way.
  if (value === null || value === undefined || value === 0 || value === '0') return
  if (!Array.isArray(value)) { refuse(); return }
  const rows = value.filter(isObject)
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.id === undefined || row.id === null || row.id === '') continue
    const id = String(row.id)
    if (ids.has(id)) refuse()
    ids.add(id)
  }
  for (const row of rows) {
    const inside = f.type === 'array' ? f.fields : blockFields(f, row.blockType, blocks)
    if (inside) checkLevel(row, inside, blocks)
  }
}

/** The fields of a row's block, whether the blocks field holds the block or names one from the config. */
function blockFields(f: Holder, type: unknown, blocks: Blocks): Field[] | undefined {
  for (const b of f.blockReferences ?? f.blocks ?? []) {
    if (typeof b !== 'string') {
      if (b.slug === type) return b.fields
    } else if (b === type) return (blocks?.[b] as BlockLike | undefined)?.fields
  }
  return undefined
}

/** Refuses write data that isn't in the shape of `fields`. `blocks` is the config's own list, for blocks named by slug. */
export function checkShape(data: unknown, fields: Field[], blocks?: Record<string, unknown>): void {
  if (isObject(data)) checkLevel(data, fields, blocks)
}

/** Runs as a `beforeOperation` hook. The answer is the same whether or not the record exists. */
export const shapeGuard: CollectionBeforeOperationHook = ({ args, collection, operation, req }) => {
  if (operation === 'create' || operation === 'update') checkShape((args as { data?: unknown }).data, collection.fields, req.payload.blocks)
}

/** The same check on what's about to be saved, which also covers restoring a version. */
export const shapeGuardChange: CollectionBeforeChangeHook = ({ data, collection, req }) => {
  checkShape(data, collection!.fields, req.payload.blocks)
  return data
}
