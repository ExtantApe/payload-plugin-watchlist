import type { Access, CollectionConfig, Field } from 'payload'

/**
 * A site's override can add fields, admin settings, hooks and narrower access. It can't remove the plugin's rules:
 * its fields (same type and target), their access and hooks, the collection's hooks (the plugin's run first), its
 * access (only narrowed, both must allow), its indexes and its endpoints (first, so they can't be shadowed) are put back
 * from an untouched build.
 */

type AnyFn = (...args: never[]) => unknown
type HookMap = Record<string, AnyFn[] | undefined>
type AnyField = { name?: string; type?: string; fields?: unknown[]; tabs?: AnyField[] }
type FieldLike = Field & { name: string; type: string; access?: Record<string, AnyFn>; hooks?: HookMap; hidden?: boolean; relationTo?: unknown; admin?: { readOnly?: boolean; hidden?: boolean } }

export function topLevelFields<T = { name: string; type: string }>(fields: readonly unknown[]): T[] {
  const out: T[] = []
  for (const f of fields as AnyField[]) {
    if (f.type === 'tabs') for (const tab of f.tabs ?? []) tab.name ? out.push(tab as T) : out.push(...topLevelFields<T>(tab.fields ?? []))
    else if (!f.name && f.fields) out.push(...topLevelFields<T>(f.fields))
    else if (f.name) out.push(f as T)
  }
  return out
}

export const isWhere = (v: unknown): boolean => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length > 0

/** Every hook and access function in a collection, so the copies the override saw can be told apart. */
export function functionsOf(c: CollectionConfig): Set<unknown> {
  const out = new Set<unknown>()
  for (const list of Object.values((c.hooks ?? {}) as HookMap)) for (const h of list ?? []) out.add(h)
  for (const fn of Object.values(c.access ?? {})) out.add(fn)
  for (const f of topLevelFields<FieldLike>(c.fields)) {
    for (const fn of Object.values(f.access ?? {})) out.add(fn)
    for (const list of Object.values(f.hooks ?? {})) for (const h of list ?? []) out.add(h)
  }
  return out
}

type FieldCheck = (args: never) => unknown
function narrowField(base: FieldCheck, extra: FieldCheck): AnyFn {
  return async (args: never) => {
    try {
      if ((await base(args)) !== true) return false
      return (await extra(args)) === true
    } catch {
      return false
    }
  }
}

/** Both must allow: the override can narrow the plugin's access, never widen it. A throw is a refusal. */
function narrow(base: Access, extra: Access): Access {
  return async (args) => {
    try {
      const a = await base(args)
      if (a !== true && !isWhere(a)) return false
      const b = await extra(args)
      if (b !== true && !isWhere(b)) return false
      if (a === true) return b
      if (b === true) return a
      return { and: [a, b] } as never
    } catch {
      return false
    }
  }
}

export function protect(base: CollectionConfig, out: CollectionConfig, seen: Set<unknown>): CollectionConfig {
  const slug = base.slug
  if (!out || typeof out !== 'object' || !Array.isArray(out.fields)) throw new Error(`Watchlist: overrides.${slug} must return the collection.`)
  if (out.slug !== slug) throw new Error(`Watchlist: overrides.${slug} changed the slug to "${out.slug}". The slug can’t change.`)
  const theirs = new Map(topLevelFields<FieldLike>(out.fields).map((f) => [f.name, f]))
  for (const field of topLevelFields<FieldLike>(base.fields)) {
    const now = theirs.get(field.name)
    if (!now) throw new Error(`Watchlist: overrides.${slug} removed the field "${field.name}", which the plugin needs.`)
    if (now.type !== field.type || JSON.stringify(now.relationTo) !== JSON.stringify(field.relationTo))
      throw new Error(`Watchlist: overrides.${slug} changed the field "${field.name}". Its type and target can’t change.`)
    if (field.access) {
      const access: Record<string, AnyFn> = { ...(now.access ?? {}) }
      for (const [op, fn] of Object.entries(field.access)) {
        const given = access[op]
        access[op] = !given || given === fn || seen.has(given) ? fn : narrowField(fn as FieldCheck, given as FieldCheck)
      }
      now.access = access
    }
    if (field.admin?.hidden) now.admin = { ...(now.admin ?? {}), hidden: true }
    if (field.hooks) {
      const hooks: HookMap = { ...(now.hooks ?? {}) }
      for (const [kind, list] of Object.entries(field.hooks)) hooks[kind] = [...(list ?? []), ...(hooks[kind] ?? []).filter((h) => !seen.has(h))]
      now.hooks = hooks as never
    }
  }
  const hooks: HookMap = { ...((out.hooks ?? {}) as HookMap) }
  for (const [kind, list] of Object.entries((base.hooks ?? {}) as HookMap)) hooks[kind] = [...(list ?? []), ...(hooks[kind] ?? []).filter((h) => !seen.has(h))]
  const access: Record<string, Access> = { ...((out.access ?? {}) as Record<string, Access>) }
  for (const [op, fn] of Object.entries((base.access ?? {}) as Record<string, Access>)) {
    const given = access[op]
    access[op] = !given || seen.has(given) ? fn : narrow(fn, given)
  }
  const keys = new Set((base.indexes ?? []).map((i) => JSON.stringify(i)))
  const indexes = [...(base.indexes ?? []), ...(out.indexes ?? []).filter((i) => !keys.has(JSON.stringify(i)))]
  // The plugin's endpoints stay, and come first, so an override's route on the same path can't take their place.
  const mine = Array.isArray(base.endpoints) ? base.endpoints : []
  const endpoints = [...mine, ...(Array.isArray(out.endpoints) ? out.endpoints.filter((e) => !mine.includes(e)) : [])]
  return { ...out, hooks: hooks as CollectionConfig['hooks'], access: access as CollectionConfig['access'], indexes, endpoints }
}
