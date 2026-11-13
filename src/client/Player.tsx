'use client'

import { useEffect, useRef, useState } from 'react'

import { isVideoId, youtubeImage } from '../ids.js'

export type PlayerProps = {
  youtubeId: string
  /** The video's title: the play button's label and the player's title. */
  title: string
  thumbnail?: string | null
  /** From YouTube; only an explicit `false` links out instead of embedding. */
  embeddable?: boolean | null
  /** Load YouTube's player only after a click (default). `false` loads it with the page. */
  loadOnClick?: boolean
  /** Wording, for translations. */
  labels?: { play?: (title: string) => string; watchOnYouTube?: string; notEmbeddable?: string }
  className?: string
}

const NOCOOKIE = 'https://www.youtube-nocookie.com/embed/'
export const embedUrl = (id: string, autoplay: boolean) => `${NOCOOKIE}${encodeURIComponent(id)}${autoplay ? '?autoplay=1' : ''}`
export const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`

/**
 * A YouTube video, click to play. Until the click the page shows the thumbnail and a real `<button>` named with the
 * title, so a visit alone loads nothing from YouTube's player. The player is youtube-nocookie.com, and focus moves to it
 * after the click. A video YouTube won't let be embedded gets a link out instead.
 */
export function Player({ youtubeId, title, thumbnail, embeddable, loadOnClick = true, labels, className }: PlayerProps) {
  const [playing, setPlaying] = useState(!loadOnClick)
  const frame = useRef<HTMLIFrameElement>(null)
  const clicked = useRef(false)
  useEffect(() => {
    if (playing && clicked.current) frame.current?.focus()
  }, [playing])
  if (!isVideoId(youtubeId)) return null
  const image = youtubeImage(thumbnail ?? null)
  const link = (
    <a href={watchUrl(youtubeId)} target="_blank" rel="noopener noreferrer">
      {labels?.watchOnYouTube ?? 'Watch on YouTube'}
    </a>
  )
  if (embeddable === false)
    return (
      <div className={className} data-watchlist-player="link-out">
        {image ? <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" /> : null}
        <p>
          {labels?.notEmbeddable ?? 'This video can only be watched on YouTube.'} {link}
        </p>
      </div>
    )
  return (
    <div className={className} data-watchlist-player={playing ? 'playing' : 'waiting'}>
      {playing ? (
        <iframe
          ref={frame}
          src={embedUrl(youtubeId, clicked.current)}
          title={title}
          allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          loading="lazy"
          style={{ border: 0, width: '100%', aspectRatio: '16 / 9' }}
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            clicked.current = true
            setPlaying(true)
          }}
          aria-label={labels?.play ? labels.play(title) : `Play: ${title}`}
          style={{ position: 'relative', display: 'block', width: '100%', aspectRatio: '16 / 9', padding: 0, border: 0, background: '#000', cursor: 'pointer' }}
        >
          {image ? <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
          <svg aria-hidden="true" focusable="false" viewBox="0 0 68 48" width="68" height="48" style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}>
            <path d="M66.5 7.7a8.5 8.5 0 0 0-6-6C55.2.3 34 .3 34 .3s-21.2 0-26.5 1.4a8.5 8.5 0 0 0-6 6C.1 13 .1 24 .1 24s0 11 1.4 16.3a8.5 8.5 0 0 0 6 6C12.8 47.7 34 47.7 34 47.7s21.2 0 26.5-1.4a8.5 8.5 0 0 0 6-6C67.9 35 67.9 24 67.9 24s0-11-1.4-16.3z" fill="#212121" fillOpacity="0.85" />
            <path d="M45 24 27 14v20z" fill="#fff" />
          </svg>
        </button>
      )}
      <p>{link}</p>
    </div>
  )
}
