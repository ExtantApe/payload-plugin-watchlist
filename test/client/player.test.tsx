// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Player } from '../../src/client/index.js'

// The player: click to play, youtube-nocookie only, a real button named with the title, a link out when YouTube
// won't let a video be embedded. Made-up IDs and titles.
const ID = 'abcDEF12345'
afterEach(cleanup)

describe('Player', () => {
  it('loads no iframe before the click, and the button is named with the title', () => {
    const { container } = render(<Player youtubeId={ID} title="Made-up care guide" thumbnail="https://i.ytimg.com/vi/x/hq.jpg" />)
    expect(container.querySelector('iframe')).toBeNull()
    const button = screen.getByRole('button', { name: 'Play: Made-up care guide' })
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('type')).toBe('button')
    expect(container.querySelector('img')!.getAttribute('alt')).toBe('')
  })

  it('after the click, a youtube-nocookie player with a title, and focus moves to it', () => {
    const { container } = render(<Player youtubeId={ID} title="Made-up care guide" />)
    fireEvent.click(screen.getByRole('button', { name: /Play/ }))
    const frame = container.querySelector('iframe')!
    expect(new URL(frame.src).origin).toBe('https://www.youtube-nocookie.com')
    expect(frame.src).toBe(`https://www.youtube-nocookie.com/embed/${ID}?autoplay=1`)
    expect(frame.title).toBe('Made-up care guide')
    expect(frame.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin')
    expect(frame.getAttribute('allow')).toContain('autoplay')
    expect(document.activeElement).toBe(frame)
  })

  it('with loadOnClick off, the player loads at once, without autoplay', () => {
    const { container } = render(<Player youtubeId={ID} title="Made-up" loadOnClick={false} />)
    expect(container.querySelector('iframe')!.src).toBe(`https://www.youtube-nocookie.com/embed/${ID}`)
  })

  it('a video that can’t be embedded links out instead', () => {
    const { container } = render(<Player youtubeId={ID} title="Made-up" embeddable={false} />)
    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    const link = screen.getByRole('link', { name: 'Watch on YouTube' })
    expect(link.getAttribute('href')).toBe(`https://www.youtube.com/watch?v=${ID}`)
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('a bad ID renders nothing; a thumbnail off YouTube’s hosts is dropped; labels translate', () => {
    expect(render(<Player youtubeId={'"><script>'} title="x" />).container.innerHTML).toBe('')
    cleanup()
    const { container } = render(<Player youtubeId={ID} title="Vidéo" thumbnail="https://example.com/x.jpg" labels={{ play: (t) => `Lire : ${t}` }} />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('button', { name: 'Lire : Vidéo' })).toBeTruthy()
  })
})
