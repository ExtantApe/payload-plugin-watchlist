import type { ComponentType, ReactNode } from 'react'

import { LINK_TARGET } from '../ui.js'

/**
 * The site's slots. Each has a plain default here, so every page works on its own; a site passes its own to match its
 * design. They're used by the server pages, so they can be server components.
 */

/** The page shell: the site's layout around the page. */
export type ShellProps = { title: string; intro?: string; children: ReactNode }
export type ShellSlot = ComponentType<ShellProps>

/** The empty state. `action` is a link. */
export type EmptyProps = { title: string; body?: string; action?: { href: string; label: string } }
export type EmptySlot = ComponentType<EmptyProps>

/** The topic filter above the video grid (the site's own picker: it knows its topics; the plugin doesn't). */
export type TopicFilterProps = { topic: string | null; kind: string | null }
export type TopicFilterSlot = ComponentType<TopicFilterProps>

export function DefaultShell({ title, intro, children }: ShellProps) {
  return (
    <main className="wl-page" style={{ maxWidth: '72rem', margin: '0 auto', padding: '1rem' }}>
      <h1>{title}</h1>
      {intro ? <p>{intro}</p> : null}
      {children}
    </main>
  )
}

export function DefaultEmpty({ title, body, action }: EmptyProps) {
  return (
    <div className="wl-empty" role="note">
      <p>
        <strong>{title}</strong>
      </p>
      {body ? <p>{body}</p> : null}
      {action ? (
        <p>
          <a href={action.href} style={LINK_TARGET}>
            {action.label}
          </a>
        </p>
      ) : null}
    </div>
  )
}

/** A page that couldn't load: the plain message. */
export function PageProblem({ message }: { message: string }) {
  return (
    <div role="alert" className="wl-problem">
      <p>{message}</p>
    </div>
  )
}
